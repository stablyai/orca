#!/usr/bin/env bash
# ============================================================================
# install-logging-setup.sh — reproduce the Orca Serve logging & diagnostic setup.
#
# One-command provisioning of the logging/triage arrangement for an external
# administrator. It provisions the config layer and per-slot state tree, and
# wires log rotation + journal retention from the templates in this directory.
# It does NOT download, build, or start the serve — this script arranges the
# *logging & diagnostics* surface only.
#
# THIS SCRIPT DOES NOT OWN THE SYSTEMD UNIT.
#   `orca-serve@.service` is a TEMPLATE unit: one file backs every slot on the
#   host (factory, canary, lesley, jessica, ...), it is hand-maintained, and
#   `scripts/install.sh` is the owner of unit deployment. This installer only
#   *seeds* the unit on a host that has none. If a unit is already present and
#   differs from the render, the script prints the diff and REFUSES (exit 3)
#   rather than rewriting a live multi-slot unit. `--force-unit` opts in to the
#   overwrite and keeps a timestamped `.bak-<UTC>` copy first.
#
# Invocation (the same script audits or installs; no flags enables install):
#   sudo bash install-logging-setup.sh --dry-run                # audit, change nothing
#   sudo bash install-logging-setup.sh                          # install factory slot
#   sudo INSTALL_PREFIX=/opt/orca_serve bash install-logging-setup.sh
#   sudo bash install-logging-setup.sh --slot canary --prefix /opt/orca_serve
#
# Exit codes: 0 ok · 1 preflight/fatal · 2 bad usage · 3 unit drift refused.
#
# Environment (flags override env — see parse_args):
#   INSTALL_PREFIX   serve tree root        (default /data/opt/revive/orca_serve)
#   SYSTEMD_DIR      systemd unit dir       (default /etc/systemd/system)
#   DEFAULT_SLOT     instance slot to make  (default factory)
#   LOGROTATE_DIR    logrotate drop-in dir  (default /etc/logrotate.d)
#   JOURNALD_DIR     journald drop-in dir   (default /etc/systemd/journald.conf.d)
#
# Requires root (writes /etc/systemd + /etc/logrotate.d), Linux, and systemd.
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Env-configurable defaults. Flags below override these.
INSTALL_PREFIX="${INSTALL_PREFIX:-/data/opt/revive/orca_serve}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
DEFAULT_SLOT="${DEFAULT_SLOT:-factory}"
LOGROTATE_DIR="${LOGROTATE_DIR:-/etc/logrotate.d}"
JOURNALD_DIR="${JOURNALD_DIR:-/etc/systemd/journald.conf.d}"

# Template sources (siblings of this script — keeps the installer relocatable).
UNIT_TEMPLATE="$SCRIPT_DIR/orca-serve@.service.template"
CONF_TEMPLATE="$SCRIPT_DIR/orca-serve.conf.template"
INSTANCE_ENV_TEMPLATE="$SCRIPT_DIR/orca-serve-instance.env.template"

# Install destinations.
UNIT_DEST="$SYSTEMD_DIR/orca-serve@.service"
CONF_DEST="$INSTALL_PREFIX/etc/orca-serve.conf"
ENV_DEST="$INSTALL_PREFIX/etc/instances/$DEFAULT_SLOT.env"
LOG_SNIPPET_DEST="$LOGROTATE_DIR/orca-serve"
JOURNAL_DROPIN="$JOURNALD_DIR/orca-serve.conf"

DRY_RUN=0
SLOT="$DEFAULT_SLOT"
FORCE_UNIT=0

# Unit-deployment outcome, reported by deploy_unit(): install | unchanged |
# refuse | overwrite. UNIT_REFUSED drives the non-zero exit on an install run.
UNIT_OUTCOME=""
UNIT_REFUSED=0
UNIT_RENDER_TMP=""
UNIT_DIFF_CAP=40

# --- UI helpers ------------------------------------------------------------
log()  { printf '%s\n' "$*" >&2; }
warn() { printf 'WARN  %s\n' "$*" >&2; }
yes()  { printf 'PASS  %s\n' "$*" >&2; }
no()   { printf 'FAIL  %s\n' "$*" >&2; hard_fail=$((hard_fail + 1)); }
die() {
  printf "[\033[31mFATAL\033[0m] %s\n" "$*" >&2
  exit 1
}
hard_fail=0

usage() {
  cat >&2 <<'USAGE'
Usage: install-logging-setup.sh [options]

Deploys the logging/diagnostics RETENTION + PLUMBING layers: the config layer,
the per-slot state tree, the logrotate snippet and the journald drop-in.

It does NOT own the systemd unit. orca-serve@.service is a hand-maintained
TEMPLATE unit backing every slot on the host; scripts/install.sh owns its
deployment. This script seeds the unit only when none exists; if one exists and
differs from the render it prints a bounded diff and exits 3 without writing.

  --dry-run | --check     Audit only: verify permissions, mounts, dependencies;
                          print the exact actions that WOULD run (including which
                          unit outcome would be taken); change nothing.
  --force-unit            Opt in to overwriting an existing, DIFFERING unit.
                          A timestamped backup (<unit>.bak-<UTC>) is written
                          first. Without this flag a drifted unit is refused.
  --prefix DIR            Override INSTALL_PREFIX (default /data/opt/revive/orca_serve).
  --systemd-dir DIR       Override SYSTEMD_DIR (default /etc/systemd/system).
  --logrotate-dir DIR     Override LOGROTATE_DIR (default /etc/logrotate.d).
  --journald-dir DIR      Override JOURNALD_DIR (default /etc/systemd/journald.conf.d).
  --slot NAME             Instance slot to provision (default factory).
  -h | --help             Show this help.

Exit codes: 0 ok · 1 preflight/fatal · 2 bad usage · 3 unit drift refused.

Environment: INSTALL_PREFIX, SYSTEMD_DIR, DEFAULT_SLOT, LOGROTATE_DIR, JOURNALD_DIR.
USAGE
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "${1:-}" in
      --dry-run|--check) DRY_RUN=1 ;;
      --prefix)        INSTALL_PREFIX="${2:?--prefix needs a value}"; shift ;;
      --prefix=*)      INSTALL_PREFIX="${1#*=}" ;;
      --systemd-dir)   SYSTEMD_DIR="${2:?--systemd-dir needs a value}"; shift ;;
      --systemd-dir=*) SYSTEMD_DIR="${1#*=}" ;;
      --logrotate-dir) LOGROTATE_DIR="${2:?--logrotate-dir needs a value}"; shift ;;
      --logrotate-dir=*) LOGROTATE_DIR="${1#*=}" ;;
      --journald-dir)  JOURNALD_DIR="${2:?--journald-dir needs a value}"; shift ;;
      --journald-dir=*) JOURNALD_DIR="${1#*=}" ;;
      --slot)          SLOT="${2:?--slot needs a value}"; shift ;;
      --slot=*)        SLOT="${1#*=}" ;;
      --force-unit)    FORCE_UNIT=1 ;;
      -h|--help)       usage; exit 0 ;;
      *)               warn "unknown argument: $1" >&2; usage; exit 2 ;;
    esac
    shift
  done

  # Re-derive destination paths that depend on any overridden vars.
  UNIT_DEST="$SYSTEMD_DIR/orca-serve@.service"
  CONF_DEST="$INSTALL_PREFIX/etc/orca-serve.conf"
  ENV_DEST="$INSTALL_PREFIX/etc/instances/$SLOT.env"
  LOG_SNIPPET_DEST="$LOGROTATE_DIR/orca-serve"
  JOURNAL_DROPIN="$JOURNALD_DIR/orca-serve.conf"
}

# --- preflight (read-only; used by both --check and install) ----------------
# Hard fails block install. Soft warnings (svc_orca : revive absent, prefix on
# the boot drive) are reported but do not block: an external box may legitimately
# differ, and the full serve installer creates those accounts.
preflight() {
  log "== Preflight: dependencies, mounts, permissions =="
  hard_fail=0

  # Dependencies
  if command -v systemctl >/dev/null 2>&1; then yes "systemctl found"; else no "systemctl not in PATH"; fi
  if [ -d /run/systemd/system ]; then yes "systemd is the running init"; else no "systemd not booted (/run/systemd/system missing)"; fi
  if command -v awk >/dev/null 2>&1; then yes "awk found"; else no "awk missing (required for @PREFIX@ substitution)"; fi
  if command -v cmp >/dev/null 2>&1; then yes "cmp found (unit drift detection)"; else warn "cmp missing — unit drift detection falls back to sha256sum"; fi
  if command -v diff >/dev/null 2>&1; then yes "diff found (unit drift reporting)"; else warn "diff missing — a drifted unit is still refused, but the diff cannot be shown"; fi

  # Source templates
  if [ -f "$UNIT_TEMPLATE" ]; then yes "unit template readable"; else no "missing $UNIT_TEMPLATE"; fi
  if [ -f "$CONF_TEMPLATE" ]; then yes "conf template readable"; else no "missing $CONF_TEMPLATE"; fi
  if [ -f "$INSTANCE_ENV_TEMPLATE" ]; then yes "instance env template readable"; else no "missing $INSTANCE_ENV_TEMPLATE"; fi

  # Identity (soft — the full serve installer provisions these)
  if command -v getent >/dev/null 2>&1; then
    getent passwd svc_orca >/dev/null 2>&1 && yes "user svc_orca exists" || warn "user svc_orca absent — create before starting the unit"
    getent group  revive    >/dev/null 2>&1 && yes "group revive exists"   || warn "group revive absent — create before starting the unit"
  else
    warn "getent absent — cannot verify svc_orca:revive; the service unit expects uid 985/gid 1200"
  fi

  # Mounts / drives (Contract I1: nothing on the boot drive). Soft: single-disk
  # hosts are a valid external choice; on multi-disk hosts /<prefix> should NOT
  # share a filesystem with /.
  prefix_fs() { local p="$INSTALL_PREFIX"; while [ ! -e "$p" ] && [ "$p" != "/" ]; do p="$(dirname "$p")"; done; stat -c %d "$p" 2>/dev/null || echo "?"; }
  local root_dev prefix_dev
  root_dev="$(stat -c %d / 2>/dev/null || echo '?')"
  prefix_dev="$(prefix_fs)"
  if [ "$prefix_dev" = "?" ] || [ "$root_dev" = "?" ]; then
    warn "cannot stat filesystem device for $INSTALL_PREFIX — assuming on data volume"
  elif [ "$prefix_dev" = "$root_dev" ]; then
    warn "$INSTALL_PREFIX shares the root filesystem (Contract I1) — prefer a data volume e.g. /data"
  else
    yes "prefix on a non-root filesystem (device $prefix_dev)"
  fi

  # Write permissions (hard in install mode via actual commands; report here)
  for d in "$SYSTEMD_DIR" "$LOGROTATE_DIR" "$JOURNALD_DIR"; do
    if [ -d "$d" ] && [ -w "$d" ]; then yes "writable: $d"
    elif [ "$(id -u)" -eq 0 ]; then yes "root: will create/write $d"
    else
      if [ "$DRY_RUN" -eq 1 ]; then
        warn "not writable by current user: $d (requires root/sudo to install)"
      else
        no "not writable by this user: $d"
      fi
    fi
  done

  if [ "$(id -u)" -eq 0 ]; then yes "running as root"; else
    if [ "$DRY_RUN" -eq 0 ]; then no "must run as root to install"; else warn "not root — install requires root; check mode only"; fi
  fi
}

# --- plan / apply ----------------------------------------------------------
# emit unit with @PREFIX@ replaced (awk gsub treats the prefix as a literal
# literal replacement for EVERY character in a path — including /, &, \, | —
# because awk gsub treats & and \ in the replacement as special (a prefix
# containing & would re-expand the placeholder). split+join has no replacement
# escaping at all.
render_unit() {
  # -v assignment processes backslash escapes (a literal \n in a prefix would
  # become a real newline); ENVIRON is literal for every character.
  INSTALL_PREFIX="$INSTALL_PREFIX" awk '
    BEGIN { p = ENVIRON["INSTALL_PREFIX"] }
    function repl(s, f, r,    n, i, o) { n = split(s, a, f); o = a[1]; for (i = 2; i <= n; i++) o = o r a[i]; return o }
    { print repl($0, "@PREFIX@", p) }' "$UNIT_TEMPLATE"
}

# Substitute placeholders in a copied template (conf/env carry @PREFIX@ in
# comments). Same substitution as the unit so no @PREFIX@ survives install.
render_template() { # <src>
  INSTALL_PREFIX="$INSTALL_PREFIX" awk '
    BEGIN { p = ENVIRON["INSTALL_PREFIX"] }
    function repl(s, f, r,    n, i, o) { n = split(s, a, f); o = a[1]; for (i = 2; i <= n; i++) o = o r a[i]; return o }
    { print repl($0, "@PREFIX@", p) }' "$1"
}

render_logrotate() {
  # Conditional `su`/`create` ownership: reference the service account only when
  # it exists, otherwise logrotate errors and refuses the whole run.
  local ownership
  if command -v getent >/dev/null 2>&1 \
     && getent passwd svc_orca >/dev/null 2>&1 \
     && getent group  revive    >/dev/null 2>&1; then
    ownership="    create 0640 svc_orca revive
    su svc_orca revive"
  else
    ownership="    create 0644 root root"
  fi

  INSTALL_PREFIX="$INSTALL_PREFIX" OWNERSHIP="$ownership" awk '
    BEGIN { p = ENVIRON["INSTALL_PREFIX"]; own = ENVIRON["OWNERSHIP"] }
    function repl(s, f, r,    n, i, o) { n = split(s, a, f); o = a[1]; for (i = 2; i <= n; i++) o = o r a[i]; return o }
    { $0 = repl($0, "__PREFIX__", p); $0 = repl($0, "__OWNERSHIP__", own); print }' <<'EOF'
# /etc/logrotate.d/orca-serve — generated by templates/orca-serve/install-logging-setup.sh
# Retention-oriented second layer. The launcher already self-rotates serve-fg.log
# at 10 MiB (inline mv to .1); logrotate here bounds long-lived slots to 7 daily
# copies and compresses them. copytruncate keeps the tee fd valid (no reopen race).
__PREFIX__/state/*/logs/*.log {
    daily
    rotate 7
    maxsize 10M
    missingok
    notifempty
    copytruncate
    compress
    delaycompress
__OWNERSHIP__
}
EOF
}

render_journald() {
  cat <<'EOF'
# /etc/systemd/journald.conf.d/orca-serve.conf — generated by install-logging-setup.sh
# Persistent journal + bounded retention so `journalctl -u orca-serve@<slot>`
# survives reboots without growing unbounded on the boot drive. Tune the caps per
# host; these are sane headless defaults.
[Journal]
Storage=persistent
SystemMaxUse=500M
SystemKeepFree=2G
MaxRetentionSec=2week
EOF
}

# Copy a template to <dest> only when <dest> is absent — never clobber an
# operator-edited live file (mirrors the .template semantics in CONTRACT §2b).
copy_if_absent() { # <src> <dest>
  local src="$1" dest="$2"
  if [ -e "$dest" ]; then
    log "  keep (already present): $dest"
  elif [ "$DRY_RUN" -eq 1 ]; then
    log "  [dry-run] would create: $dest  (from $(basename "$src"))"
  else
    render_template "$src" > "$dest"
    chmod 0644 "$dest"
    log "  created: $dest  (from $(basename "$src"))"
  fi
}

# --- unit deployment (non-destructive by default) ---------------------------
# orca-serve@.service is a TEMPLATE unit: ONE file backs every slot on the host
# (factory, canary, lesley, jessica, ...), including production factory slots.
# Rewriting it from this installer would silently re-point every slot at once,
# so the unit gets the same copy-if-absent discipline as the config layer, plus
# an explicit refusal (and diff) when the live file has drifted.
cleanup() { if [ -n "${UNIT_RENDER_TMP:-}" ]; then rm -f -- "$UNIT_RENDER_TMP"; fi; }
trap cleanup EXIT

files_identical() { # <a> <b>
  if command -v cmp >/dev/null 2>&1; then
    cmp -s "$1" "$2"
  else
    [ "$(sha256sum <"$1" | cut -d' ' -f1)" = "$(sha256sum <"$2" | cut -d' ' -f1)" ]
  fi
}

# Bounded unified diff: first $UNIT_DIFF_CAP lines plus a suppressed-line count,
# so a 200-line drift cannot bury the refusal message it is explaining.
unit_diff_report() { # <live> <render>
  if ! command -v diff >/dev/null 2>&1; then
    # No diff(1): the refusal still stands, but the operator must not be left
    # without the evidence. Report the digests and where to look instead.
    warn "diff(1) not in PATH — showing digests instead of a unified diff"
    log "  | live:   $1"
    log "  |         sha256 $(sha256sum <"$1" | cut -d' ' -f1)"
    log "  | render: $(basename "$UNIT_TEMPLATE") with @PREFIX@=$INSTALL_PREFIX"
    log "  |         sha256 $(sha256sum <"$2" | cut -d' ' -f1)"
    log "  | to inspect the render, re-run with --dry-run on a host that has diff(1)"
    return 0
  fi
  local d total changed
  d="$(mktemp)"
  diff -u --label "live:   $1" --label "render: $(basename "$UNIT_TEMPLATE")" \
    "$1" "$2" >"$d" 2>/dev/null || true
  total="$(awk 'END { print NR + 0 }' "$d")"
  changed="$(awk '/^[-+][^-+]/ { n++ } END { print n + 0 }' "$d")"
  awk -v cap="$UNIT_DIFF_CAP" 'NR <= cap { print "  | " $0 }' "$d" >&2
  if [ "$total" -gt "$UNIT_DIFF_CAP" ]; then
    log "  | ... $((total - UNIT_DIFF_CAP)) more diff line(s) suppressed"
  fi
  log "  drift: $changed changed line(s), $total-line unified diff"
  rm -f -- "$d"
}

install_unit_file() { # <rendered> — atomic replace within SYSTEMD_DIR
  mkdir -p "$SYSTEMD_DIR"
  cp -- "$1" "$UNIT_DEST.tmp"
  chmod 0644 "$UNIT_DEST.tmp"
  mv -f "$UNIT_DEST.tmp" "$UNIT_DEST"
}

backup_unit() { # timestamped .bak-<UTC>, matching the estate convention
  local bak
  bak="$UNIT_DEST.bak-$(date -u +%Y%m%dT%H%M%SZ)"
  cp -p -- "$UNIT_DEST" "$bak"
  log "  backed up live unit -> $bak"
}

deploy_unit() {
  UNIT_RENDER_TMP="$(mktemp)"
  render_unit >"$UNIT_RENDER_TMP"

  if [ ! -e "$UNIT_DEST" ]; then
    UNIT_OUTCOME="install"
    if [ "$DRY_RUN" -eq 1 ]; then
      log "  unit outcome=install — [dry-run] would create $UNIT_DEST (@PREFIX@=$INSTALL_PREFIX)"
    else
      install_unit_file "$UNIT_RENDER_TMP"
      log "  unit outcome=install — created $UNIT_DEST (@PREFIX@=$INSTALL_PREFIX)"
    fi
  elif files_identical "$UNIT_DEST" "$UNIT_RENDER_TMP"; then
    UNIT_OUTCOME="unchanged"
    log "  unit outcome=unchanged — $UNIT_DEST is already byte-identical to the render"
  elif [ "$FORCE_UNIT" -eq 1 ]; then
    UNIT_OUTCOME="overwrite"
    log "  unit outcome=overwrite (--force-unit) — $UNIT_DEST differs from the render:"
    unit_diff_report "$UNIT_DEST" "$UNIT_RENDER_TMP"
    if [ "$DRY_RUN" -eq 1 ]; then
      log "  [dry-run] would back up to $UNIT_DEST.bak-<UTC> then overwrite $UNIT_DEST"
    else
      backup_unit
      install_unit_file "$UNIT_RENDER_TMP"
      log "  unit outcome=overwrite — rewrote $UNIT_DEST (backup retained)"
    fi
  else
    UNIT_REFUSED=1
    if [ "$DRY_RUN" -eq 1 ]; then
      UNIT_OUTCOME="would-refuse"
      log "  unit outcome=would-refuse — $UNIT_DEST differs from the render:"
    else
      UNIT_OUTCOME="refuse"
      log "  unit outcome=REFUSED — $UNIT_DEST differs from the render; left untouched:"
    fi
    unit_diff_report "$UNIT_DEST" "$UNIT_RENDER_TMP"
    log "  The live unit is hand-maintained and is a TEMPLATE unit: one file backs"
    log "  every slot on this host, so rewriting it re-points them all at once."
    log "  scripts/install.sh is the owner of unit deployment; this installer owns"
    log "  only the retention/plumbing layers."
    log "  Next action: review the diff above, then either"
    log "    (a) land the change through scripts/install.sh / orca-serve@.service.template, or"
    log "    (b) re-run with --force-unit to overwrite (a .bak-<UTC> copy is kept first)."
  fi

  cleanup
  UNIT_RENDER_TMP=""
}

apply() {
  log "== Actions for prefix=$INSTALL_PREFIX slot=$SLOT (dry-run: $([ "$DRY_RUN" -eq 1 ] && echo yes || echo no)) =="

  # 1. systemd instance unit — seed-only; see deploy_unit() for the refusal path
  deploy_unit

  # 2. config layer (files)
  if [ "$DRY_RUN" -eq 1 ]; then
    log "  [dry-run] would mkdir -p $INSTALL_PREFIX/etc/instances"
  else
    mkdir -p "$INSTALL_PREFIX/etc/instances"
  fi
  copy_if_absent "$CONF_TEMPLATE" "$CONF_DEST"
  copy_if_absent "$INSTANCE_ENV_TEMPLATE" "$ENV_DEST"

  # 3. per-slot state tree (logs, config/orca, diagnostics, tmp)
  local state_dir="$INSTALL_PREFIX/state/$SLOT"
  local dirs=(
    "$state_dir/logs"
    "$state_dir/config/orca"
    "$state_dir/diagnostics"
    "$state_dir/tmp"
  )
  local d
  for d in "${dirs[@]}"; do
    if [ "$DRY_RUN" -eq 1 ]; then
      log "  [dry-run] would mkdir -p $d"
    else
      mkdir -p "$d"
      # Best-effort ownership: match the svc_orca:revive service identity when it
      # exists, so the unit (User=svc_orca, Group=revive) can write its logs/diag.
      if command -v getent >/dev/null 2>&1 \
         && getent passwd svc_orca >/dev/null 2>&1 \
         && getent group  revive    >/dev/null 2>&1; then
        chown -R svc_orca:revive "$d"
      fi
      chmod 0750 "$d"
    fi
  done

  # 4. log rotation + journal retention
  if [ "$DRY_RUN" -eq 1 ]; then
    log "  [dry-run] would write logrotate snippet -> $LOG_SNIPPET_DEST"
    log "  [dry-run] would write journald drop-in -> $JOURNAL_DROPIN"
  else
    mkdir -p "$LOGROTATE_DIR" "$JOURNALD_DIR"
    render_logrotate > "$LOG_SNIPPET_DEST"
    chmod 0644 "$LOG_SNIPPET_DEST"
    log "  installed logrotate snippet: $LOG_SNIPPET_DEST"
    render_journald > "$JOURNAL_DROPIN"
    chmod 0644 "$JOURNAL_DROPIN"
    log "  installed journald drop-in: $JOURNAL_DROPIN"
    if systemctl is-system-running --quiet 2>/dev/null || systemctl daemon-reload 2>/dev/null; then
      log "  ran: systemctl daemon-reload"
    else
      log "  skipped: systemctl daemon-reload (systemd bus not connected / container environment)"
    fi
  fi
}

print_verification() {
  local P="$INSTALL_PREFIX" S="$SLOT"
  cat <<EOF

== Verification — run these after install ====================================
# 1. unit structurally valid + not yet active (enable when ready)
systemd-analyze verify orca-serve@$S.service
# 2. unit rendered with YOUR prefix in every structural env
systemctl cat orca-serve@$S.service | grep -E 'ORCA_SERVE_LOGDIR|DIAG_DIR|ORCA_INSTANCE'
# 3. state tree + config layer present, owned by the service account
ls -la $P/state/$S/{logs,config/orca,diagnostics,tmp} $P/etc/
# 4. logrotate config is valid (dry-run = no rotation performed)
logrotate -d $LOG_SNIPPET_DEST
# 5. start the slot, then watch both sinks
systemctl enable --now orca-serve@$S.service
journalctl -u orca-serve@$S.service -n 50 --no-pager
tail -f $P/state/$S/logs/serve-fg.log
==============================================================================
journald change is active after:  systemctl restart systemd-journald
EOF
}

# --- main -------------------------------------------------------------------
parse_args "$@"

log "Orca Serve logging/diagnostic installer"
log "  INSTALL_PREFIX=$INSTALL_PREFIX"
log "  SYSTEMD_DIR=$SYSTEMD_DIR"
log "  slot=$SLOT"
log "  mode=$([ "$DRY_RUN" -eq 1 ] && echo 'dry-run (no changes)' || echo 'install')"
echo

preflight

if [ "$DRY_RUN" -eq 1 ]; then
  echo
  apply
  echo
  log "Dry-run unit outcome: ${UNIT_OUTCOME:-unknown} (install = seed a missing unit, unchanged = already identical, would-refuse = drift, unit left alone)"
  if [ "$hard_fail" -eq 0 ]; then
    log "Dry-run complete: all hard checks passed, no changes made."
  else
    log "Dry-run complete: $hard_fail hard check(s) failed (see FAIL lines)."
  fi
  exit "$hard_fail"
fi

if [ "$hard_fail" -ne 0 ]; then
  die "preflight failed ($hard_fail issue(s)) — fix FAIL lines or use --dry-run to triage."
fi

apply
echo
print_verification

if [ "$UNIT_REFUSED" -eq 1 ]; then
  log "== Summary: retention/plumbing installed; UNIT NOT MODIFIED (outcome=$UNIT_OUTCOME) =="
  log "  $UNIT_DEST drifted from the template render and was left byte-for-byte intact."
  log "  Resolve via scripts/install.sh (owner of unit deployment), or re-run with"
  log "  --force-unit to overwrite it (a .bak-<UTC> copy is written first)."
  exit 3
fi
log "Unit outcome: $UNIT_OUTCOME"
log "Done. Enable/start with: systemctl enable --now orca-serve@$SLOT.service"