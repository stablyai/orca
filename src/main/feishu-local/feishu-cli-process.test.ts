import { expect, it } from 'vitest'
import { feishuProfileEnvironment } from './feishu-cli-process'

it('gives CLI operations the local profile directory without accepting ambient credentials for another app', () => {
  const env = {
    PATH: '',
    LARKSUITE_CLI_CONFIG_DIR: 'profiles',
    LARKSUITE_CLI_APP_ID: 'other-app',
    larksuite_cli_tenant_access_token: 'synthetic',
    LARKSUITE_CLI_USER_ACCESS_TOKEN: 'synthetic',
    LARKSUITE_CLI_AUTH_PROXY: 'fixture',
    LARKSUITE_CLI_APP_SECRET: 'synthetic'
  }
  expect(feishuProfileEnvironment(env)).toEqual({ PATH: '', LARKSUITE_CLI_CONFIG_DIR: 'profiles' })
})
