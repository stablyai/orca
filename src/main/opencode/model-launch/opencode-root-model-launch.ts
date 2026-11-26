import type { AgentStartupShell } from '../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { resolveCommandOnLocalPath } from '../../ipc/command-path/command-path-resolver'
import { resolveOpenCodeLaunchModelConfig } from './opencode-launch-model-config'
import { probeOpenCodeLaunchModelContext } from './opencode-launch-model-context'
import { isVerifiedOpenCodeConfigModelVersion } from './opencode-model-version-policy'
import { planOpenCodeRootModelRewrite } from './opencode-root-model-overlay'

/** Moves a root `--model` into the launch's config overlay; anything it cannot apply stays as typed. */
export async function applyOpenCodeRootModelOverlay(options: {
  command: string
  shell: AgentStartupShell
  version: string | null
  launchEnv: Record<string, string>
  /** The environment the launch actually inherits, so an existing overlay is extended, not replaced. */
  probeEnv: Record<string, string>
  envToDelete: string[]
  cwd?: string
  /** The startup prompt Orca quoted onto the command, when it is still there. */
  promptBody?: string
}): Promise<string> {
  if (!isVerifiedOpenCodeConfigModelVersion(options.version)) {
    return options.command
  }
  const rewrite = planOpenCodeRootModelRewrite(options.command, options.shell, options.promptBody)
  if (!rewrite) {
    return options.command
  }
  const executable =
    rewrite.probeExecutable && options.cwd
      ? await resolveCommandOnLocalPath(rewrite.probeExecutable, {
          env: options.probeEnv,
          cwd: options.cwd
        }).catch(() => null)
      : null
  const context =
    executable && options.cwd
      ? await probeOpenCodeLaunchModelContext({
          executable,
          cwd: options.cwd,
          env: options.probeEnv
        }).catch(() => null)
      : null
  const configContent = resolveOpenCodeLaunchModelConfig({
    configContent: options.probeEnv.OPENCODE_CONFIG_CONTENT,
    primaryAgent: context?.primaryAgent,
    model: rewrite.model
  })
  if (configContent === null) {
    return options.command
  }
  options.launchEnv.OPENCODE_CONFIG_CONTENT = configContent
  const deletion = options.envToDelete.indexOf('OPENCODE_CONFIG_CONTENT')
  if (deletion !== -1) {
    options.envToDelete.splice(deletion, 1)
  }
  return rewrite.command
}
