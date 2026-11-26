import type { BrowserPageZoomDirection } from '../../../../shared/browser/site-settings/browser-page-zoom'
import type {
  BrowserPageSiteDisplay,
  BrowserSiteColorScheme
} from '../../../../shared/browser/site-settings/browser-site-display'
import type { BrowserSiteDisplayController } from '../../site-settings/display/browser-site-display-controller'
import { captureRemoteCliBrowserRevocation } from '../../../runtime/desktop-browser-bridge/remote-cli-browser-scope'
import { AgentBrowserBridgeMouseCommands } from './agent-browser-bridge-mouse-commands'

/** A hosted page's site zoom and color scheme, which its streamed pane reads and changes through the runtime. */
export abstract class AgentBrowserBridgeSiteDisplayCommands extends AgentBrowserBridgeMouseCommands {
  zoom(
    direction: BrowserPageZoomDirection,
    worktreeId?: string,
    browserPageId?: string
  ): BrowserPageSiteDisplay | null {
    return this.runSiteDisplayCommand(worktreeId, browserPageId, (controller, guestId) =>
      controller.zoomPage(guestId, direction)
    )
  }

  siteDisplay(worktreeId?: string, browserPageId?: string): BrowserPageSiteDisplay | null {
    return this.runSiteDisplayCommand(worktreeId, browserPageId, (controller, guestId) =>
      controller.getPageDisplay(guestId)
    )
  }

  setSiteColorScheme(
    colorScheme: BrowserSiteColorScheme | null,
    worktreeId?: string,
    browserPageId?: string
  ): BrowserPageSiteDisplay | null {
    return this.runSiteDisplayCommand(worktreeId, browserPageId, (controller, guestId) =>
      controller.setColorScheme(guestId, colorScheme)
    )
  }

  // Not queued: how the page is shown is the person's view of it, not an action an agent's command waits on.
  private runSiteDisplayCommand(
    worktreeId: string | undefined,
    browserPageId: string | undefined,
    run: (
      controller: BrowserSiteDisplayController,
      guestId: number
    ) => BrowserPageSiteDisplay | null
  ): BrowserPageSiteDisplay | null {
    this.assertCommandAdmission()
    const assertNotRevoked = captureRemoteCliBrowserRevocation()
    const { webContentsId } = this.resolveCommandTarget(worktreeId, browserPageId)
    assertNotRevoked(webContentsId)
    const controller = this.browserManager.getSiteDisplayController()
    return controller ? run(controller, webContentsId) : null
  }
}
