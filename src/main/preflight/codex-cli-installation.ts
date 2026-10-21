import {
  codexCliInstallation,
  parseCodexCliVersion,
  type CodexCliInstallation
} from '../../shared/codex-cli-installation'
import type { ProcessSpec } from '@orca/process-host/process-spec'
import { readAgentCliVersion } from '../agent-cli-version-probe'

export async function readCodexCliInstallation(
  input: Pick<ProcessSpec, 'program' | 'cwd' | 'env'>
): Promise<CodexCliInstallation> {
  const result = await readAgentCliVersion(input, parseCodexCliVersion)
  return codexCliInstallation(true, result.version)
}
