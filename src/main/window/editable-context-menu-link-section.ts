import { z } from 'zod'
import {
  richMarkdownContextMenuCommandChannel,
  type RichMarkdownContextMenuCommandPayload,
  type RichMarkdownContextMenuLinkTarget
} from '../../shared/rich-markdown-context-menu'
import type { InstalledBrowser } from '../../shared/external-browser-types'
import { translateMain } from '../i18n/main-i18n'

/** What the rich editor's link section needs from main's browser catalog and clipboard. */
export type EditableContextMenuLinkActions = {
  /** The renderer reported that this link's source can open in Orca Browser. */
  canOpenInOrca: boolean
  browsers: readonly InstalledBrowser[]
  /** The configured external browser's name; null means the OS default. */
  externalDefaultName: string | null
  /** Without a browserId, main applies the configured external default. */
  openUrl: (url: string, browserId?: string) => void
  copyText: (text: string) => void
}

// zod numbers reject NaN and Infinity.
const linkTargetSchema = z.object({ x: z.number(), y: z.number() })

export function parseRichMarkdownContextMenuLinkTarget(
  value: unknown
): RichMarkdownContextMenuLinkTarget | null {
  const target = linkTargetSchema.safeParse(value)
  return target.success ? target.data : null
}

function openInLabel(browser: string): string {
  return translateMain('components.linkActions.openInBrowser', 'Open in {{browser}}', { browser })
}

/** Mirrors the renderer's shared link menu so rich-editor links match other link surfaces. */
export function buildEditableContextMenuLinkSection(
  url: string,
  link: EditableContextMenuLinkActions,
  webContents: Pick<Electron.WebContents, 'send'>,
  point: { x: number; y: number }
): Electron.MenuItemConstructorOptions[] {
  const template: Electron.MenuItemConstructorOptions[] = []
  if (link.canOpenInOrca) {
    template.push({
      label: openInLabel(
        translateMain(
          'auto.components.terminal.pane.TerminalLinkActionPopover.orcaBrowser',
          'Orca Browser'
        )
      ),
      click: () => {
        // Orca Browser tabs belong to the renderer's workspace, so the renderer opens it.
        const payload: RichMarkdownContextMenuCommandPayload = {
          command: 'open-link-in-orca-browser',
          ...point
        }
        webContents.send(richMarkdownContextMenuCommandChannel, payload)
      }
    })
  }
  template.push({
    label: openInLabel(
      link.externalDefaultName ??
        translateMain(
          'auto.components.terminal.pane.TerminalLinkActionPopover.systemBrowser',
          'System Browser'
        )
    ),
    click: () => link.openUrl(url)
  })
  if (link.browsers.length > 0) {
    template.push({
      label: translateMain('components.linkActions.openInSubmenu', 'Open in'),
      submenu: link.browsers.map((browser) => ({
        label: browser.name,
        click: () => link.openUrl(url, browser.id)
      }))
    })
  }
  template.push(
    {
      label: translateMain('components.linkActions.copyLink', 'Copy Link'),
      click: () => link.copyText(url)
    },
    { type: 'separator' }
  )
  return template
}
