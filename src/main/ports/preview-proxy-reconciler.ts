// Why: the preview proxy has two config sources — `orca serve --preview-*`
// flags and the persisted previewProxy setting, which paired clients edit live.
// One reconciler owns the listener so a settings change restarts it in place,
// flags always win while present, and a bind failure surfaces as status
// instead of crashing the app a remote client just reconfigured.
import { randomBytes } from 'node:crypto'
import { isValidPreviewToken } from '../../shared/preview-proxy-token'
import type { GlobalSettings, PreviewProxyStatus } from '../../shared/types'
import type { PreviewRouteResolver } from './preview-route-resolver'
import { WorktreePreviewProxy, type PreviewProxyAuthMode } from './worktree-preview-proxy'
import {
  parsePreviewDomain,
  setActivePreviewProxyConfig,
  type PreviewPublicOrigin
} from './worktree-preview-routes'

export type PreviewProxyDesiredConfig = {
  port: number
  bindHost: string
  domain: string
  auth: PreviewProxyAuthMode
  token: string | null
}

export type { PreviewProxyStatus }

const LOOPBACK_BINDS = new Set(['127.0.0.1', 'localhost', '::1'])

export function defaultPreviewAuthForBind(bindHost: string): PreviewProxyAuthMode {
  return LOOPBACK_BINDS.has(bindHost) ? 'open' : 'token'
}

export function desiredPreviewConfigFromSettings(
  settings: Pick<GlobalSettings, 'previewProxy'>
): PreviewProxyDesiredConfig | null {
  const preview = settings.previewProxy
  const domain = preview?.domain?.trim()
  if (
    !preview?.enabled ||
    !domain ||
    !Number.isInteger(preview.port) ||
    preview.port <= 0 ||
    preview.port > 65535
  ) {
    return null
  }
  const bindHost = preview.bindHost?.trim() || '127.0.0.1'
  return {
    port: preview.port,
    bindHost,
    domain,
    auth: preview.auth ?? defaultPreviewAuthForBind(bindHost),
    token: preview.token?.trim() || null
  }
}

export class PreviewProxyReconciler {
  private proxy: WorktreePreviewProxy | null = null
  private appliedKey: string | null = null
  private flagsConfig: PreviewProxyDesiredConfig | null = null
  private settingsConfig: PreviewProxyDesiredConfig | null = null
  private currentStatus: PreviewProxyStatus = { running: false, source: null }
  // Why: stable per process so settings edits don't rotate an omitted token
  // and invalidate every preview URL a client already copied.
  private generatedToken: string | null = null
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly options: { resolveRoutes: PreviewRouteResolver }) {}

  /** Serve-flags config; overrides settings entirely while non-null. */
  setFlagsConfig(config: PreviewProxyDesiredConfig | null): Promise<void> {
    this.flagsConfig = config
    return this.reconcile()
  }

  applySettings(settings: Pick<GlobalSettings, 'previewProxy'>): Promise<void> {
    this.settingsConfig = desiredPreviewConfigFromSettings(settings)
    return this.reconcile()
  }

  status(): PreviewProxyStatus {
    return this.currentStatus
  }

  async stop(): Promise<void> {
    this.flagsConfig = null
    this.settingsConfig = null
    await this.reconcile()
  }

  private reconcile(): Promise<void> {
    // Why: serialized — a settings save racing another must not interleave
    // stop/start pairs and strand two listeners or none.
    const run = this.tail.then(() => this.reconcileNow())
    this.tail = run.catch(() => {})
    return run
  }

  private async reconcileNow(): Promise<void> {
    const source: PreviewProxyStatus['source'] = this.flagsConfig
      ? 'flags'
      : this.settingsConfig
        ? 'settings'
        : null
    const desired = this.flagsConfig ?? this.settingsConfig
    const key = desired ? JSON.stringify([source, desired]) : null
    if (key === this.appliedKey) {
      return
    }

    if (this.proxy) {
      await this.proxy.stop()
      this.proxy = null
      setActivePreviewProxyConfig(null)
    }
    this.appliedKey = null
    if (!desired) {
      this.currentStatus = { running: false, source: null }
      return
    }

    let origin: PreviewPublicOrigin
    try {
      origin = parsePreviewDomain(desired.domain)
    } catch (error) {
      this.currentStatus = {
        running: false,
        source,
        error: error instanceof Error ? error.message : String(error)
      }
      return
    }
    // Why: a token outside the cookie-safe alphabet (persisted before this
    // validation existed, or written by an older client) would truncate the
    // auth cookie silently; surface it as status like a bad domain.
    if (desired.token && !isValidPreviewToken(desired.token)) {
      this.currentStatus = {
        running: false,
        source,
        error: 'Preview token must use 1-512 characters from A-Za-z0-9 . _ ~ -'
      }
      return
    }
    const token =
      desired.auth === 'token'
        ? (desired.token ?? (this.generatedToken ??= randomBytes(24).toString('base64url')))
        : null
    const proxy = new WorktreePreviewProxy({
      bindHost: desired.bindHost,
      port: desired.port,
      origin,
      auth: desired.auth,
      token,
      resolveRoutes: this.options.resolveRoutes
    })
    try {
      const { port } = await proxy.start()
      this.proxy = proxy
      this.appliedKey = key
      setActivePreviewProxyConfig({ origin, token })
      this.currentStatus = {
        running: true,
        source,
        origin: `${origin.protocol}://*.${origin.host}${origin.port ? `:${origin.port}` : ''}`,
        bindHost: desired.bindHost,
        port,
        auth: desired.auth,
        token
      }
    } catch (error) {
      this.currentStatus = {
        running: false,
        source,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }
}
