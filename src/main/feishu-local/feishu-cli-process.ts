import { resolveCommandOnLocalPath } from '../ipc/command-path/command-path-resolver'
import { FeishuHostError } from './feishu-cli-status'

// The CLI's environment credential provider precedes the named profile, even with --as bot.
const overridesProfile =
  /^LARKSUITE_CLI_(?:APP_ID|APP_SECRET|TENANT_ACCESS_TOKEN(?:_SOURCE)?|USER_ACCESS_TOKEN|AUTH_PROXY|PROXY_(?:ENABLE|ADDRESS|KEY)|DEFAULT_AS|PROFILE|BRAND)$/i

export function feishuProfileEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(([key]) => !overridesProfile.test(key))
  )
}

export async function feishuCliProcess() {
  const env = feishuProfileEnvironment(process.env)
  // An explicit Windows shim path lets the process host resolve its Node entry without a shell.
  const program =
    process.platform === 'win32'
      ? await resolveCommandOnLocalPath('lark-cli', { env, cwd: '' })
      : 'lark-cli'
  if (!program) {
    throw new FeishuHostError('cli-missing')
  }
  return { program, env }
}
