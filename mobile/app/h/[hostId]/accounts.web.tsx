import { MobileAccountsScreen } from '../../../src/accounts/MobileAccountsScreen'

// Render screen directly: native sibling imports a shell module that throws in browsers, and manifest imports every route.
export default function MobileAccountsRoute() {
  return <MobileAccountsScreen />
}
