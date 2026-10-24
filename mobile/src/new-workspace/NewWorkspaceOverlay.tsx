import { useCallback, useState } from 'react'
import { useRouter } from 'expo-router'
import { HostProtocolGate } from '../components/HostProtocolGate'
import { MobileWebShellScreen } from '../mobile-web-shell/MobileWebShellScreen'
import type { ShellOverlayLoad } from '../mobile-web-shell/shell-overlay-load'
import { shellScreenRoute } from '../mobile-web-shell/shell-screen-route'
import { NewWorkspaceLoadingDrawer } from './NewWorkspaceLoadingDrawer'
import { OpenHostListInstead } from './open-host-list-instead'

const LOADING: ShellOverlayLoad = { kind: 'loading', download: null }

/**
 * The picked desktop's Create Workspace page in the shell, as an overlay: the page draws the drawer
 * over a transparent document, and one short loading drawer stands in until it has painted.
 */
export function NewWorkspaceOverlay({ hostId }: { hostId: string }) {
  const router = useRouter()
  const [load, setLoad] = useState(LOADING)
  // Stable, so a drag in progress keeps its handler across the download's re-renders.
  const cancel = useCallback(() => router.back(), [router])
  const route = shellScreenRoute({ pathname: `/h/${encodeURIComponent(hostId)}/new-workspace` })
  if (route === null || load.kind === 'unavailable') {
    return <OpenHostListInstead hostId={hostId} />
  }
  return (
    <>
      {/* The gate every `/h` route gets from its layout, which this one sits outside of to overlay Home. */}
      <HostProtocolGate
        hostId={hostId}
        transparentWhilePending
        blocked={<OpenHostListInstead hostId={hostId} />}
      >
        <MobileWebShellScreen hostId={hostId} route={route} onOverlayLoad={setLoad} />
      </HostProtocolGate>
      <NewWorkspaceLoadingDrawer
        visible={load.kind === 'loading'}
        download={load.kind === 'loading' ? load.download : null}
        onCancel={cancel}
      />
    </>
  )
}
