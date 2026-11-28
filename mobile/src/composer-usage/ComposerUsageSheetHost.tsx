import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useState,
  type ReactNode
} from 'react'
import { Keyboard, StyleSheet, View, type LayoutChangeEvent } from 'react-native'
import type { AccountsSnapshot } from '../accounts/accounts-snapshot'
import { useAccountsSnapshot } from './accounts-snapshot-store'
import type { AgentUsage } from './agent-usage-provider'
import {
  ComposerUsageClientContext,
  ComposerUsagePaneWidthContext
} from './composer-usage-client-context'

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
  const [paneWidth, setPaneWidth] = useState<number | null>(null)
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
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const width = event.nativeEvent.layout.width
    setPaneWidth((current) => (current === width ? current : width))
  }, [])
  const active = request ?? shown
  return (
    <ComposerUsagePaneWidthContext.Provider value={paneWidth}>
      <ComposerUsageSheetContext.Provider value={open}>
        <View style={styles.host} onLayout={onLayout}>
          {children}
        </View>
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
    </ComposerUsagePaneWidthContext.Provider>
  )
}

const styles = StyleSheet.create({
  host: {
    flex: 1,
    minWidth: 0,
    minHeight: 0
  }
})

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
