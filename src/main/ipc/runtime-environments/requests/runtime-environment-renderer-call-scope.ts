import { resolveEnvironment } from '../../../../shared/remote-runtime/host-store/runtime-environment-store'
import { CREDENTIAL_VAULT_METHOD } from '../../../../shared/rpc-contract/host-management/credential-vault-params'

export function resolveRendererRuntimeCallEnvironment(
  userDataPath: string,
  args: { selector: string; method: string }
): ReturnType<typeof resolveEnvironment> {
  if (args.method === CREDENTIAL_VAULT_METHOD) {
    throw new Error('Use the credential vault settings.')
  }
  return resolveEnvironment(userDataPath, args.selector)
}
