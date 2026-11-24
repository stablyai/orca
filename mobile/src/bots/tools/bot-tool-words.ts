// A tool's words on the phone: its name, and its sign-in face as the desktop's botToolSignInWords
// line, Needs you line and button.
import type { AgentType } from '../../../../src/shared/agent-status/contracts/agent-status-types'
import { BOT_MCP_APPS } from '../../../../src/shared/bots/bot-mcp-apps'
import { botToolTitle } from '../../../../src/shared/bots/bot-tool-labels'
import type { BotToolSignInFace } from '../../../../src/shared/bots/bot-tool-sign-in-face'
import type { Translate } from '../../i18n/mobile-i18n'

export type ToolsBot = { id: string; name: string; agent: AgentType }

/** The tool's name as Add to <bot> lists it, else from its name on the bot. */
export const botToolAppName = (name: string): string =>
  BOT_MCP_APPS.find((app) => app.id === name)?.name ?? botToolTitle(name)

export function botToolSignInLine(
  face: BotToolSignInFace | null,
  t: Translate,
  hostName: string
): string | null {
  switch (face) {
    case 'signed-in':
      return t('bots.tools.face.signedIn', 'Signed in')
    case 'needs-sign-in':
      return t('bots.tools.face.needsSignIn', 'Needs sign-in')
    case 'sign-in-again':
      return t('bots.tools.face.signInAgain', 'Sign in again')
    case 'waiting':
      return t('bots.tools.face.finishInBrowser', 'Finish in browser')
    case 'finishing':
      return t('bots.tools.face.finishing', 'Finishing sign-in…')
    case 'update-needed':
      return t('bots.tools.face.updateHost', 'Update Orca on {{host}}', { host: hostName })
    case 'unreachable':
      return t('bots.tools.face.cantReach', 'Can’t reach')
    case 'unsupported':
      return t('bots.tools.face.unsupported', 'This app isn’t supported yet')
    case null:
      return null
  }
}

/** What Needs you says the face asks of the owner; null when it isn't a sign-in to ask for. */
export function botToolSignInNeed(
  face: BotToolSignInFace | null,
  t: Translate,
  name: string
): string | null {
  return face === 'needs-sign-in'
    ? t('bots.needs.signIn', '{{name}} needs you to sign in.', { name })
    : face === 'sign-in-again'
      ? t('bots.needs.signInAgain', '{{name}} needs you to sign in again.', { name })
      : null
}

/** The button that starts a sign-in, when the face calls for one. */
export function botToolSignInActionLabel(
  face: BotToolSignInFace | null,
  t: Translate
): string | null {
  return face === 'needs-sign-in' || face === 'sign-in-again'
    ? t('bots.tools.signIn.action', 'Sign in')
    : face === 'unreachable'
      ? t('bots.tools.tryAgain', 'Try again')
      : null
}
