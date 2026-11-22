// The pages Connectors opens in place of its list; `from` is where a setup's Close returns.
export type ConnectorPage =
  | { kind: 'list' }
  | { kind: 'add' }
  /** No team: a bot whose app was removed but whose Slack people remain. */
  | { kind: 'slack'; teamId: string | undefined }
  | { kind: 'slack-setup'; teamId: string | undefined; from: ConnectorPage }
  | { kind: 'linear'; workspaceId: string }
  /** No workspace: from Add a connector, another than the bot's. */
  | { kind: 'linear-setup'; workspaceId: string | undefined; from: ConnectorPage }
  /** No installation: GitHub as a whole, until it is linked and installed. */
  | { kind: 'github'; installationId: string | null }
  | { kind: 'github-setup'; from: ConnectorPage }
  | { kind: 'google' }
  | { kind: 'google-connect'; from: ConnectorPage }
  | { kind: 'composio'; app: string; label: string | null }
  | { kind: 'composio-connect'; app: { slug: string; name: string }; from: ConnectorPage }
  /** The desktop's Fix key: a new key for the one Composio refuses. */
  | { kind: 'composio-key' }
  /** An app the bot has as a tool; `signIn` opens on its sign-in. */
  | { kind: 'tool'; name: string; signIn: boolean }
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
      | 'composio'
      | 'composio-connect'
      | 'composio-key'
  }
>
