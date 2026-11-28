// A slot's PID marker can be empty or garbled after a crash; these shell pieces write it safely and judge it fail-closed (#51014).

/** Shell that records `value` at `path` via temp file and rename, so an interrupted write leaves no empty marker. */
export function writeOrcadPidAtomicallyCommand(value: string, path: string): string {
  return `echo ${value} > "${path}.tmp" && mv -f "${path}.tmp" "${path}"`
}

/** Defines `orcad_slot_busy L S` (0 another process's argv names an entry, 1 none, 2 unprovable) and `orcad_unnamed`. */
export function posixSlotProcessScanShellFunction(): string {
  // The glob expands before this shell forks a reader, so only $$ and $PPID can be the probe.
  // A listed process whose argv cannot be read may run the slot, so it is unprovable, not absent.
  const viaProc =
    'for orcad_sp in /proc/[0-9]*; do orcad_sp=${orcad_sp#/proc/}; ' +
    '{ [ "$orcad_sp" = "$$" ] || [ "$orcad_sp" = "$PPID" ]; } && continue; ' +
    'orcad_sa=$(tr "\\000" " " 2>/dev/null < "/proc/$orcad_sp/cmdline") || ' +
    '{ [ -e "/proc/$orcad_sp" ] && return 2; continue; }; ' +
    'case "$orcad_sa" in *"$1"* | *"$2"*) return 0;; esac; done; return 1;'
  // A subshell that has not exec'd ps yet carries this shell's argv, so skip this shell's children.
  // The match is printed, not exited on, so no shell's last-pipeline-stage semantics matter.
  const viaPs =
    'orcad_sl=$(ps -A -ww -o pid= -o ppid= -o args= 2>/dev/null) && [ -n "$orcad_sl" ] || return 2; ' +
    'orcad_sm=$(printf "%s\\n" "$orcad_sl" | while read -r orcad_sp orcad_spp orcad_sa; do ' +
    '{ [ "$orcad_sp" = "$$" ] || [ "$orcad_sp" = "$PPID" ] || [ "$orcad_spp" = "$$" ]; } && continue; ' +
    // The leading "(" keeps older bash parsers from closing $( at the pattern's ")".
    'case "$orcad_sa" in (*"$1"* | *"$2"*) echo busy; break;; esac; done); ' +
    '[ -n "$orcad_sm" ] && return 0; return 1;'
  return (
    `orcad_slot_busy() { if [ -r /proc/self/cmdline ]; then ${viaProc} fi; ${viaPs} }; ` +
    // A marker naming no PID is stale only when no process runs this slot.
    'orcad_unnamed() { orcad_slot_busy "$orcad_launcher" "$orcad_server"; ' +
    'case $? in 1) echo DEAD;; *) echo UNKNOWN;; esac; };'
  )
}
