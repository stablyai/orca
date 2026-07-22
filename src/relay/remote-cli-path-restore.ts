export function getRemoteCliPathRestoreBlock(): string {
  return `# Why: user startup files can move a competing host CLI ahead of the relay bridge.
if [[ -n "\${ORCA_REMOTE_CLI_BIN_DIR:-}" ]]; then
  __orca_path_remaining="\${PATH-}"
  __orca_path_without_remote=""
  __orca_path_has_entry=0
  while :; do
    if [[ "$__orca_path_remaining" == *:* ]]; then
      __orca_path_entry="\${__orca_path_remaining%%:*}"
      __orca_path_remaining="\${__orca_path_remaining#*:}"
      __orca_path_last=0
    else
      __orca_path_entry="$__orca_path_remaining"
      __orca_path_last=1
    fi
    if [[ "$__orca_path_entry" != "$ORCA_REMOTE_CLI_BIN_DIR" ]]; then
      if (( __orca_path_has_entry )); then
        __orca_path_without_remote="$__orca_path_without_remote:$__orca_path_entry"
      else
        __orca_path_without_remote="$__orca_path_entry"
        __orca_path_has_entry=1
      fi
    fi
    (( __orca_path_last )) && break
  done
  if (( __orca_path_has_entry )); then
    export PATH="$ORCA_REMOTE_CLI_BIN_DIR:$__orca_path_without_remote"
  else
    export PATH="$ORCA_REMOTE_CLI_BIN_DIR"
  fi
  unset __orca_path_remaining __orca_path_without_remote __orca_path_has_entry
  unset __orca_path_entry __orca_path_last
fi`
}
