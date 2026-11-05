import { basename, win32 as pathWin32 } from 'node:path'

export const POSIX_SHELL_STARTUP_COMMAND_ENV = 'ORCA_POSIX_SHELL_STARTUP_COMMAND'

export function supportsPosixShellStartupCommand(shellPath: string): boolean {
  const shellName = pathWin32.basename(basename(shellPath)).toLowerCase()
  return shellName === 'bash' || shellName === 'zsh' || shellName === 'fish'
}

export function getBashStartupCommandPromptBlock(): string {
  return `if [[ \${${POSIX_SHELL_STARTUP_COMMAND_ENV}+present} == present ]]; then
  __orca_remove_startup_command_prompt_hook() {
    local __orca_item
    local -a __orca_remaining=()
    if (( BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 1) )); then
      for __orca_item in "\${PROMPT_COMMAND[@]+"\${PROMPT_COMMAND[@]}"}"; do
        [[ "$__orca_item" == "__orca_run_startup_command" ]] || __orca_remaining+=("$__orca_item")
      done
      PROMPT_COMMAND=("\${__orca_remaining[@]+"\${__orca_remaining[@]}"}")
    else
      for __orca_item in "\${__orca_prompt_command_suffix[@]+"\${__orca_prompt_command_suffix[@]}"}"; do
        [[ "$__orca_item" == "__orca_run_startup_command" ]] || __orca_remaining+=("$__orca_item")
      done
      __orca_prompt_command_suffix=("\${__orca_remaining[@]+"\${__orca_remaining[@]}"}")
    fi
  }
  __orca_run_startup_command() {
    local __orca_command="$${POSIX_SHELL_STARTUP_COMMAND_ENV}" __orca_status
    unset ${POSIX_SHELL_STARTUP_COMMAND_ENV}
    __orca_remove_startup_command_prompt_hook
    unset -f __orca_remove_startup_command_prompt_hook
    builtin history -s "$__orca_command" 2>/dev/null || true
    builtin printf '%s\n' "$__orca_command"
    eval "$__orca_command"
    __orca_status=$?
    unset -f __orca_run_startup_command
    return "$__orca_status"
  }
  __orca_append_prompt_command "__orca_run_startup_command"
fi`
}
