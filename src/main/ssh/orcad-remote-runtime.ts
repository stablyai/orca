import { ORCAD_BUILD_TARGET_FILENAME, orcadBunRuntimeFilename } from '../../shared/orcad-artifacts'
import { assertPosixOrcadHost } from './orcad-remote-host-support'
import { shellEscape } from './ssh-connection-utils'
import { joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'

/** Only legacy slots may use host Node; an incomplete Bun slot must not change runtimes. */
export function selectOrcadSlotRuntimeCommand(
  host: RemoteHostPlatform,
  directory: string,
  legacyNodePath: string
): string {
  assertPosixOrcadHost(host)
  const runtime = shellEscape(joinRemotePath(host, directory, orcadBunRuntimeFilename(host.os)))
  const target = shellEscape(joinRemotePath(host, directory, ORCAD_BUILD_TARGET_FILENAME))
  return (
    `if [ -e ${target} ] || [ -e ${runtime} ]; then ` +
    `[ -x ${runtime} ] || exit 78; orcad_runtime=${runtime}; ` +
    `else orcad_runtime=${shellEscape(legacyNodePath)}; fi`
  )
}
