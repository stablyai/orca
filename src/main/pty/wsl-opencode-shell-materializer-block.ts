import { ORCA_WSL_OPENCODE_MATERIALIZER_ENV } from './wsl-orca-env'

export function getWslOpenCodeShellMaterializerBlock(): string {
  return `# Why: WSL must build its OpenCode overlay on the Linux filesystem after
# the real guest rc files reveal any custom OPENCODE_CONFIG_DIR. The sourced
# script finishes before the shell-ready marker can release an agent command.
if [[ -n "\${${ORCA_WSL_OPENCODE_MATERIALIZER_ENV}:-}" && -f "\$${ORCA_WSL_OPENCODE_MATERIALIZER_ENV}" ]]; then
  source "\$${ORCA_WSL_OPENCODE_MATERIALIZER_ENV}"
fi`
}
