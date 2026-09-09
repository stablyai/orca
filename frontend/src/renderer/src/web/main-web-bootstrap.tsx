// Why: extracted bootstrap function makes the web entry point unit-testable
// without side-effecting module-level imports in main.tsx.
import React from 'react'
import ReactDOM from 'react-dom/client'
import { lazyWithRetry as lazy } from '@/lib/lazy-with-retry'
import { Suspense, useMemo, useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  clearPairingInputFromAddressBar,
  decideWebPairingStartup,
  readPairingInputFromLocation
} from './web-pairing'
import {
  createSessionWebRuntimeEnvironment,
  createStoredWebRuntimeEnvironment,
  readStoredWebRuntimeEnvironment,
  saveStoredWebRuntimeEnvironment
} from './web-runtime-environment'
import { installWebPreloadApi } from './web-preload-api'
import { I18nProvider } from '../i18n/I18nProvider'
import { translate } from '../i18n/i18n'
import { RecoverableRenderErrorBoundary } from '../components/error-boundaries/RecoverableRenderErrorBoundary'
import { ConnectionStatusProvider } from './ConnectionStatusProvider'
import { ConnectionStatusBanner } from './ConnectionStatusBanner'
import { useConnectionStatus, useConnectionRetry } from './ConnectionStatusProvider'
import { WebSocketRpcClient } from '../../../platform/adapters/web/rpc-client'
import type { IRpcClient } from '../../../platform/rpc-client-interface'
import { fetchCurrentUser, fetchAuthConfig, refreshSession } from '../auth/auth-api-client'
import type { AuthUser, SsoProvider } from '../auth/auth-types'
import { useLogout } from '../hooks/useLogout'
import { initBrowserTrace } from '../../../shared/trace/browser'
import { TracePanel } from '../components/trace/TracePanel'
import { useAppStore } from '../store'

const App = lazy(() => import('../App'))
import { WorkspaceProvider } from '../context/WorkspaceContext'
const LoginPage = lazy(() => import('./login/LoginPage').then((m) => ({ default: m.LoginPage })))

export type BootstrapOptions = {
  rootElementId?: string
  maxRetries?: number
  retryDelayMs?: number
  wsUrl?: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function showErrorUi(rootEl: HTMLElement): void {
  rootEl.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui;color:#ef4444">
      <div style="text-align:center">
        <h2>Cannot connect to Orca backend</h2>
        <p>Make sure the Orca server is running at the expected address.</p>
        <button onclick="location.reload()"
                style="padding:8px 16px;background:#3b82f6;color:white;border:none;border-radius:6px;cursor:pointer">
          Retry
        </button>
      </div>
    </div>
  `
}

/**
 * Listen for `orca:auth-failed` events emitted by WebSessionClient / WebRuntimeClient
 * when the WebSocket closes with code 4401 (session cookie missing/expired).
 *
 * On auth failure: redirect to /login so the user can sign in again — no
 * manual intervention required.
 *
 * FE-SOL-STORAGE-007(a): a 401/expired-token/transient disconnect is NOT a
 * logout intent, so this must NOT wipe localStorage/sessionStorage.
 * workspaceSession / orca.saved-instances / accountsDevServer stay put so
 * re-authenticating (as the SAME user) restores dev-server/agent state
 * exactly as it was before the disconnect. A genuine user switch is instead
 * caught after re-auth by enforceWorkspaceOwnerOnReauth() below, which does
 * the wipe when it actually applies. Explicit logout (FE-TASK-STORAGE-016)
 * keeps its own unconditional clear — that IS a real wipe intent.
 *
 * Guards: only runs once (redirected flag), only for session-auth environments.
 * (E2EE pairing is no longer reachable from the multi-user bootstrap path —
 * see CR-FE2E-002 — this check is now a defensive no-op for that path, kept
 * because bootstrapWebApp() and main.tsx's WebRoot still share this file's
 * exported helpers with tests.)
 */
export function installAuthFailedRedirect(): void {
  let redirected = false
  window.addEventListener('orca:auth-failed', () => {
    if (redirected) {
      return
    }
    const env = readStoredWebRuntimeEnvironment()
    if (env?.id !== 'session-auth') {
      return
    }
    redirected = true
    console.warn('[Orca] Auth failed — redirecting to /login (local state preserved)')
    document.cookie.split(';').forEach((c) => {
      const name = c.split('=')[0].trim()
      if (!name) {
        return
      }
      const exp = 'expires=Thu, 01 Jan 1970 00:00:00 GMT'
      document.cookie = `${name}=; ${exp}; path=/`
      document.cookie = `${name}=; ${exp}; path=/; domain=${location.hostname}`
      document.cookie = `${name}=; ${exp}; path=/; domain=.${location.hostname}`
    })
    window.location.href = '/login'
  })
}

// Duplicated from web-preload-api.ts's (unexported) SESSION_STORAGE_KEY — kept
// as a plain string here rather than importing that module, since pulling in
// web-preload-api.ts's full session-hydration/remote-sync surface for one key
// name is out of scope for FE-TASK-STORAGE-015. Must stay in sync with it.
const WORKSPACE_SESSION_STORAGE_KEY = 'orca.web.workspaceSession.v1'

/**
 * FE-SOL-STORAGE-007(a) — mandatory safety check paired with the auth-failure
 * handler above no longer wiping state: after a successful (re-)auth, compare
 * the signed-in user's id against `ownerUserId` recorded on the persisted
 * WorkspaceSessionState. Same user (or first-ever login, no owner recorded
 * yet) → keep everything, just (re)stamp ownership. Different user → this is
 * a genuine account switch, not a resume, so wipe local state exactly like
 * logout does before stamping the new owner.
 */
export function enforceWorkspaceOwnerOnReauth(userId: string): void {
  let previousOwnerId: string | undefined
  try {
    const raw = window.localStorage.getItem(WORKSPACE_SESSION_STORAGE_KEY)
    if (raw) {
      previousOwnerId = (JSON.parse(raw) as { ownerUserId?: string }).ownerUserId
    }
  } catch {
    // Malformed JSON — treat as "no recorded owner" rather than blocking login.
  }

  if (previousOwnerId && previousOwnerId !== userId) {
    try {
      localStorage.clear()
    } catch {
      /* sandboxed iframe */
    }
    try {
      sessionStorage.clear()
    } catch {
      /* sandboxed iframe */
    }
  }

  try {
    const raw = window.localStorage.getItem(WORKSPACE_SESSION_STORAGE_KEY)
    const stored = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    window.localStorage.setItem(
      WORKSPACE_SESSION_STORAGE_KEY,
      JSON.stringify({ ...stored, ownerUserId: userId })
    )
  } catch {
    /* sandboxed iframe / storage quota */
  }
}

// Why: banner wrapper reads from ConnectionStatusProvider context so it stays
// in sync with the connection poll without prop-drilling through App.
// onLogout is forwarded so the banner's Logout button can clear stale sessions
// (e.g., after container restart) without requiring the user to find the avatar menu.
function WebConnectionBannerWrapper(): React.JSX.Element | null {
  const status = useConnectionStatus()
  const retry = useConnectionRetry()
  const logout = useLogout()
  return <ConnectionStatusBanner status={status} onRetry={retry} onLogout={logout} />
}

// Why: WebRoot encapsulates the pairing/app decision so it can be tested
// independently of the ReactDOM.createRoot lifecycle.
type WebRootProps = {
  client: IRpcClient
}

// CR-LOGIN-001 (TASK-FE-007): auth session check result fed in by WebRootBoundary
type WebRootAuthContext = {
  sessionUser: AuthUser | null
  availableProviders: SsoProvider[]
}

function WebRoot({
  client,
  sessionUser,
  availableProviders
}: WebRootProps & WebRootAuthContext): React.JSX.Element {
  const initialPairingInput = useMemo(() => readPairingInputFromLocation(window.location), [])
  const startupDecision = useMemo(() => {
    const decision = decideWebPairingStartup({
      initialPairingInput,
      hasStoredEnvironment: readStoredWebRuntimeEnvironment() !== null
    })
    if (
      decision.kind === 'auto-save-runtime-offer' ||
      (decision.kind === 'show-connect' && decision.initialPairingInput !== null)
    ) {
      clearPairingInputFromAddressBar()
    }
    return decision
  }, [initialPairingInput])

  const [hasEnvironment] = useState(() => {
    if (startupDecision.kind === 'auto-save-runtime-offer') {
      saveStoredWebRuntimeEnvironment(
        createStoredWebRuntimeEnvironment({ name: 'Orca Server', offer: startupDecision.offer })
      )
      return true
    }
    return startupDecision.kind === 'use-stored-environment'
  })

  // Why: `sessionUser` was resolved here (WebRootBoundary's fetchCurrentUser
  // call) and used ONLY to decide LoginPage vs App — it was never wired into
  // useAppStore's authSlice, so `currentUser`/`currentUser.role` read null/
  // undefined everywhere below <App/> (live-verified: DepartmentGate's admin
  // bypass never fired for the actual bootstrap admin account, and Settings'
  // Admin Console never rendered for anyone). Mirror it into the store once
  // per sessionUser identity change so `useAppStore(s => s.currentUser)`
  // consumers (DepartmentGate, Settings, OnboardingFlow's skip branch) see
  // the real signed-in user instead of null.
  useEffect(() => {
    if (sessionUser === null) {
      return
    }
    // FE-SOL-STORAGE-007(a): must run before anything reads persisted
    // workspace state — a different user re-authenticating wipes it here.
    enforceWorkspaceOwnerOnReauth(sessionUser.id)
    const store = useAppStore.getState()
    store.setCurrentUser({
      id: sessionUser.id,
      email: sessionUser.email,
      name: sessionUser.name,
      avatarUrl: sessionUser.avatarUrl,
      role: sessionUser.role
    })
    store.setAuthStatus('authenticated')
  }, [sessionUser])

  // CR-LOGIN-001: if the user is already authenticated via session cookie,
  // skip the WebConnect / pairing flow entirely and render the App directly.
  if (sessionUser !== null) {
    // Why: installWebPreloadApi reads activeEnvironment from localStorage via
    // readStoredWebRuntimeEnvironment(). Without a stored environment, all RPC
    // calls fail with "No active runtime environment" because requireActiveEnvironment()
    // throws. Create a stable 'session-auth' environment (no E2EE — cookie auth)
    // before installing the API so RPC calls route through WebSocketRpcClient.
    // Guard: only create if no existing environment — don't overwrite a paired env.
    // See TASK-PC-002 / TASK-PC-003 in specs/backend/bugs/paircode-v1/.
    if (readStoredWebRuntimeEnvironment() === null) {
      saveStoredWebRuntimeEnvironment(createSessionWebRuntimeEnvironment(window.location))
    }
    installWebPreloadApi()
    return (
      <ConnectionStatusProvider client={client}>
        <WebConnectionBannerWrapper />
        <Suspense fallback={<div className="min-h-dvh bg-background" />}>
          <WorkspaceProvider>
            <App />
          </WorkspaceProvider>
        </Suspense>
      </ConnectionStatusProvider>
    )
  }

  if (!hasEnvironment) {
    // Show Login page (local/SSO only — CR-FE2E-002 removed the PairCodeFallback
    // that used to live inside it, since this path always has login available).
    // After successful SSO/local login the page reloads and sessionUser will be set.
    return (
      <Suspense fallback={<div className="min-h-dvh bg-background" />}>
        <LoginPage
          availableProviders={availableProviders}
          onLoginSuccess={() => {
            window.location.href = '/'
          }}
        />
      </Suspense>
    )
  }

  installWebPreloadApi()
  return (
    <ConnectionStatusProvider client={client}>
      <WebConnectionBannerWrapper />
      <Suspense fallback={<div className="min-h-dvh bg-background" />}>
        <App />
      </Suspense>
    </ConnectionStatusProvider>
  )
}

// CR-RBAC-003: session Orca tự issue có TTL cố định phía server (xem
// backend-go's domain.Session) — refresh định kỳ ở khoảng thời gian ngắn hơn
// hẳn TTL đó (ví dụ 15 phút nếu TTL là 24h) để không bao giờ chạm hạn khi tab
// vẫn mở, mà không cần backend trả expiresAt (giữ AuthUser shape không đổi).
const SESSION_REFRESH_INTERVAL_MS = 15 * 60 * 1000

function WebRootBoundary({ client }: WebRootProps): React.JSX.Element {
  useTranslation()
  // CR-LOGIN-001 (TASK-FE-007): resolve auth session before first render so
  // WebRoot can decide whether to show LoginPage or go straight to App.
  const [sessionUser, setSessionUser] = useState<AuthUser | null>(null)
  const [availableProviders, setAvailableProviders] = useState<SsoProvider[]>([])
  const [authResolved, setAuthResolved] = useState(false)

  useEffect(() => {
    Promise.all([
      fetchCurrentUser().catch(() => null),
      fetchAuthConfig().catch(() => ({ providers: [], localEnabled: true }))
    ]).then(([user, config]) => {
      setSessionUser(user)
      setAvailableProviders(config.providers as SsoProvider[])
      setAuthResolved(true)
    })
  }, [])

  useEffect(() => {
    if (sessionUser === null) {
      return
    }
    const timer = setInterval(() => {
      refreshSession()
        .then((refreshed) => {
          if (refreshed === null) {
            // Session đã bị revoke — không silently issue token mới (đúng
            // tiêu chí chấp nhận CR-003). Đăng xuất mềm: reload để
            // WebRootBoundary tự phát hiện lại qua fetchCurrentUser().
            window.location.href = '/'
          }
        })
        .catch(() => {
          // Lỗi mạng thoáng qua — không logout, thử lại ở lần interval kế tiếp.
        })
    }, SESSION_REFRESH_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [sessionUser])

  if (!authResolved) {
    // Minimal blank splash while auth check is in flight
    return <div className="min-h-dvh bg-background" />
  }

  return (
    <RecoverableRenderErrorBoundary
      boundaryId="web.root"
      surface="web-root"
      title={translate('app.recoverableError.webTitle', 'Orca web hit a renderer error.')}
      description={translate(
        'app.recoverableError.webDescription',
        'Retry the web client or reconnect to the paired runtime.'
      )}
    >
      <WebRoot client={client} sessionUser={sessionUser} availableProviders={availableProviders} />
    </RecoverableRenderErrorBoundary>
  )
}

/**
 * Testable bootstrap function for web mode.
 * Extracted from main.tsx so the startup sequence can be exercised in Vitest.
 */
export async function bootstrapWebApp(options: BootstrapOptions = {}): Promise<void> {
  const { rootElementId = 'root', maxRetries = 3, retryDelayMs = 2000, wsUrl } = options

  const rootEl = document.getElementById(rootElementId)
  if (!rootEl) {
    console.error(`[Orca Web] Root element #${rootElementId} not found`)
    return
  }

  // Why: create a lightweight RPC client for connection status tracking;
  // the full pairing-based WebRuntimeClient is initialised inside WebRoot.
  const client = new WebSocketRpcClient(wsUrl)

  let connected = false
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await client.connect()
      connected = true
      break
    } catch {
      if (attempt < maxRetries) {
        await sleep(retryDelayMs)
      }
    }
  }

  if (!connected) {
    showErrorUi(rootEl)
    return
  }

  // Install early so auth-failed events from any WebSocket client trigger redirect.
  installAuthFailedRedirect()

  // Initialize browser trace sink — must happen before ReactDOM.createRoot
  // so trace events from initial renders are captured.
  initBrowserTrace((event) => {
    useAppStore.getState().addTraceEvent(event)
  })

  // Ctrl+Shift+T → toggle TracePanel
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'T') {
      e.preventDefault()
      const state = useAppStore.getState()
      state.setTracePanelOpen(!state.tracePanelOpen)
    }
  })

  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <I18nProvider>
        <WebRootBoundary client={client} />
        <TracePanel />
      </I18nProvider>
    </React.StrictMode>
  )

  // Register Service Worker for Web Push notifications (non-fatal — web mode only)
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('/service-worker.js')
      console.log('[Web] Service Worker registered for push notifications')
    } catch {
      console.warn('[Web] Service Worker registration failed (non-fatal)')
    }
  }
}
