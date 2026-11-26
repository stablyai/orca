import { isAbsolute, join } from 'node:path'
import type { TuiAgent } from '../../shared/agent-launch/catalog/tui-agent'
import {
  normalizeRuntimePathForComparison,
  relativePathInsideRoot
} from '../../shared/file-access/cross-platform-path'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import { MANAGED_AGENT_CLI_IDS, managedAgentCli } from './managed-agent-cli-registry'

export function managedPathAgent(program: string): TuiAgent | undefined {
  if (!isAbsolute(program) || !/[\\/]agent-runtimes[\\/]/i.test(program)) {
    return undefined
  }
  const dataDirectory = getProfileUserDataPath()
  return MANAGED_AGENT_CLI_IDS.find((agent) => {
    const cli = managedAgentCli(agent)
    const root = cli.runtime.root(dataDirectory)
    const release = relativePathInsideRoot(root, program)?.split('/')[0]
    if (!release || release === '.' || release === '..') {
      return false
    }
    const folder = join(root, release)
    const actual = normalizeRuntimePathForComparison(program)
    return (
      actual === normalizeRuntimePathForComparison(cli.executable(folder)) ||
      (cli.launcher !== undefined &&
        actual === normalizeRuntimePathForComparison(cli.launcher(folder)))
    )
  })
}
