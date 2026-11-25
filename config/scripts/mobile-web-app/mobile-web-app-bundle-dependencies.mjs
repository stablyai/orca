import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDir = fileURLToPath(new URL('../../..', import.meta.url))

// Mobile CI requires dependencies so broken installs fail instead of silently skipping their tests.
export const MOBILE_WEB_APP_DEPENDENCIES_REQUIRED_ENV = 'ORCA_MOBILE_WEB_APP_DEPS_REQUIRED'

export const MOBILE_WEB_APP_DEPENDENCY_PATH = join(
  projectDir,
  'mobile',
  'node_modules',
  'react-native-web'
)

const SKIP_NOTICE =
  '[mobile-web-app] skipping the bundling tests: mobile/node_modules/react-native-web is absent. ' +
  'They run for real in pr.yml, in the mobile_web_app job, which installs mobile dependencies.'

// Sharded root tests omit mobile/node_modules; check availability before bundling react-native-web pages.
export function mobileWebAppDependenciesPresent(modulePath = MOBILE_WEB_APP_DEPENDENCY_PATH) {
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
