/** The host's own Orca account sign-in, which a phone runs on the host it names; spread into the
 *  execution-host routes. Signing in/out needs the same power as running commands on the host. */
export const MOBILE_ORCA_ACCOUNT_RPC_METHODS = [
  'orcaAccount.selectOrg',
  'orcaAccount.signIn.cancel',
  'orcaAccount.signIn.complete',
  'orcaAccount.signIn.start',
  'orcaAccount.signIn.wait',
  'orcaAccount.signOut',
  'orcaAccount.status',
  'orcaAccount.subscribe',
  'orcaAccount.unsubscribe'
] as const
