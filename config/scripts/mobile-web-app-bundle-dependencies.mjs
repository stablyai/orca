import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDir = fileURLToPath(new URL('../..', import.meta.url))

/**
 * Set by the one CI job that installs mobile dependencies, so a broken install there fails the
 * job instead of quietly skipping every test that would have caught it.
 */
export const MOBILE_WEB_APP_DEPENDENCIES_REQUIRED_ENV = 'ORCA_MOBILE_WEB_APP_DEPS_REQUIRED'

const SKIP_NOTICE =
  '[mobile-web-app] skipping the bundling tests: mobile/node_modules/react-native-web is absent. ' +
  'They run for real in pr.yml, in the mobile_web_app job, which installs mobile dependencies.'

/**
 * Bundling the Route A page resolves react-native-web out of mobile/node_modules, which the
 * sharded `test` job deliberately does not install. Tests that bundle ask this first.
 */
export function mobileWebAppDependenciesPresent(
  modulePath = join(projectDir, 'mobile', 'node_modules', 'react-native-web')
) {
  if (existsSync(modulePath)) {
    return true
  }
  if (process.env[MOBILE_WEB_APP_DEPENDENCIES_REQUIRED_ENV] === '1') {
    throw new Error(
      `[mobile-web-app] ${modulePath} is missing in a job that installs mobile dependencies`
    )
  }
  console.log(SKIP_NOTICE)
  return false
}
