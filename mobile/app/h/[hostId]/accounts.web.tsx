import { MobileAccountsScreen } from '../../../src/accounts/MobileAccountsScreen'

/**
 * The page's route for the accounts screen: the screen itself. The native route file mounts the
 * shell, whose native view module throws at import in a browser, and the manifest imports every route.
 */
export default function MobileAccountsRoute() {
  return <MobileAccountsScreen />
}
