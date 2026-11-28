import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useState,
  type ReactNode
} from 'react'
import { Keyboard } from 'react-native'
import type { AccountsSnapshot } from '../accounts/accounts-snapshot'
import { useAccountsSnapshot } from './accounts-snapshot-store'
import type { AgentUsage } from './agent-usage-provider'
import { ComposerUsageClientContext } from './composer-usage-client-context'

const ComposerUsageSheet = lazy(() =>
  import('./ComposerUsageSheet').then((module) => ({ default: module.ComposerUsageSheet }))
)

export type ComposerUsageSheetRequest = {
  usage: AgentUsage
  snapshot: AccountsSnapshot
  spanSideStrip: boolean
}

const ComposerUsageSheetContext = createContext<
  ((request: ComposerUsageSheetRequest) => void) | null
>(null)

/** Hosts the usage pop-up above the composer so folding the pill never unmounts it. */
export function ComposerUsageSheetHost({ children }: { children: ReactNode }): React.JSX.Element {
  const client = useContext(ComposerUsageClientContext)
  const [request, setRequest] = useState<ComposerUsageSheetRequest | null>(null)
  // Kept after close so the sheet slides out still showing what it showed.
  const [shown, setShown] = useState<ComposerUsageSheetRequest | null>(null)
  // Subscribe only while open so agentless tabs never open the accounts stream.
  const liveSnapshot = useAccountsSnapshot(request !== null ? client : null)
  const open = useCallback((next: ComposerUsageSheetRequest) => {
    setShown(next)
    setRequest(next)
  }, [])
  const close = useCallback(() => setRequest(null), [])
  const active = request ?? shown
  return (
    <ComposerUsageSheetContext.Provider value={open}>
      {children}
      {active ? (
        <Suspense fallback={null}>
          <ComposerUsageSheet
            visible={request !== null}
            onClose={close}
            usage={active.usage}
            snapshot={liveSnapshot ?? active.snapshot}
            spanSideStrip={active.spanSideStrip}
          />
        </Suspense>
      ) : null}
    </ComposerUsageSheetContext.Provider>
  )
}

/** Opens the hosted pop-up, falling back to an inline sheet outside a session host. */
export function useComposerUsageSheetOpener(
  usage: AgentUsage | null,
  snapshot: AccountsSnapshot | null,
  spanSideStrip: boolean
): {
  open: () => void
  inlineSheet: React.ReactNode
} {
  const openInHost = useContext(ComposerUsageSheetContext)
  const [localOpen, setLocalOpen] = useState(false)
  const open = (): void => {
    if (!usage || !snapshot) {
      return
    }
    if (openInHost) {
      openInHost({ usage, snapshot, spanSideStrip })
    } else {
      setLocalOpen(true)
    }
    Keyboard.dismiss()
  }
  const inlineSheet =
    !openInHost && usage && snapshot ? (
      <Suspense fallback={null}>
        <ComposerUsageSheet
          visible={localOpen}
          onClose={() => setLocalOpen(false)}
          usage={usage}
          snapshot={snapshot}
          spanSideStrip={spanSideStrip}
        />
      </Suspense>
    ) : null
  return { open, inlineSheet }
}
