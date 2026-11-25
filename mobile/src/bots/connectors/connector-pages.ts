// The pages Connectors opens in place of its list; `from` is where a setup's Close returns.
import type { GoogleServiceChoice } from '../../../../src/shared/google/google-scopes'

/** What Google's sign-in asks for; absent services: what the account has, else all. */
export type GoogleSignInAsk = {
  account?: string
  services?: GoogleServiceChoice[]
  /** Signs a saved account in through this computer's app, as a setup that just made it does. */
  currentApp?: boolean
}

export type ConnectorPage =
  | { kind: 'list' }
  | { kind: 'add' }
  /** No team: a bot whose app was removed but whose Slack people remain. */
  | { kind: 'slack'; teamId: string | undefined }
  | { kind: 'slack-setup'; teamId: string | undefined; from: ConnectorPage }
  | { kind: 'linear'; workspaceId: string }
  /** No workspace: from Add a connector, another than the bot's. */
  /** `signIn`: opens on Linear's sign-in, as Reconnect does. */
  | { kind: 'linear-setup'; workspaceId: string | undefined; from: ConnectorPage; signIn?: true }
  /** No installation: GitHub as a whole, until it is linked and installed. */
  | { kind: 'github'; installationId: string | null }
  /** `signIn`: opens on GitHub's sign-in, as Add another GitHub account, Refresh and Reconnect do. */
  | { kind: 'github-setup'; from: ConnectorPage; signIn?: true }
  /** `account`: opens on that account's page. */
  | { kind: 'google'; account?: string }
  /** `signedIn`: back from Google's sign-in, which never opens again from here; `setup` when the chat's setup
   *  asked for it, so turning Google on also answers its step. */
  | { kind: 'google-connect'; from: ConnectorPage; signedIn?: 'connect' | 'setup' }
  /** Google's sign-in, as Reconnect, Allow again and Add another account start it. `next`: `connect` goes
   *  on to turn Google on, `setup` also answers the chat's setup. */
  | {
      kind: 'google-sign-in'
      ask: GoogleSignInAsk
      from: ConnectorPage
      next?: 'connect' | 'setup'
      /** Google warns about an app that is the person's own and brand new. */
      newApp?: true
    }
  | { kind: 'composio'; app: string; label: string | null }
  | { kind: 'composio-connect'; app: { slug: string; name: string }; from: ConnectorPage }
  /** The desktop's Fix key: a new key for the one Composio refuses. */
  | { kind: 'composio-key' }
  /** An app the bot has as a tool; `signIn` opens on its sign-in, `editing` on its Edit page. */
  | { kind: 'tool'; name: string; signIn: boolean; editing?: boolean }
  /** Add by URL; `preset`: a listed app's address and name, to add as they are or change first. */
  | { kind: 'add-tool'; preset?: { source: string; name: string }; from: ConnectorPage }

export type AccountConnectorPage = Extract<
  ConnectorPage,
  {
    kind:
      | 'linear'
      | 'linear-setup'
      | 'github'
      | 'github-setup'
      | 'google'
      | 'google-connect'
      | 'google-sign-in'
      | 'composio'
      | 'composio-connect'
      | 'composio-key'
  }
>
