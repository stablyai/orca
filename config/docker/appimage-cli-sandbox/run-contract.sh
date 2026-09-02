#!/usr/bin/env bash
# Dollar signs are intentionally literal argv fixtures.
# shellcheck disable=SC2016
set -euo pipefail

app_root=/artifacts/root
app_run="$app_root/AppRun"
expected_args='["alpha","","two words","dollar$sign","snowman-☃","--flag=value","omega"]'
expected_sandbox_arg='["alpha","--no-sandbox","omega"]'
cli_bootstrap='(async()=>{const path=require("path");const cli=path.join(process.env.APPDIR,"resources","app.asar.unpacked","out","cli","index.js");await Promise.resolve(require(cli).main(process.argv.slice(1)))})().catch(error=>{console.error(error&&error.stack?error.stack:String(error));process.exit(1)})'

install -d -o orca -g orca /tmp/orca-appimage-gui
cat >"$app_root/unshare" <<'EOF'
#!/usr/bin/env bash
printf 'unshare-called\n' >>/tmp/orca-appimage-unshare.log
exit 1
EOF
chmod 755 "$app_root/unshare"
rm -f /tmp/orca-appimage-unshare.log

failures=0
for value in 0 1 1-ish; do
  capture=$(runuser -u orca -- env ELECTRON_RUN_AS_NODE="$value" APPDIR="$app_root" \
    "$app_run" -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' -- \
    alpha '' 'two words' 'dollar$sign' 'snowman-☃' --flag=value omega 2>&1) || {
    printf 'FAIL node-capture value=%s output=%s\n' "$value" "$capture" >&2
    failures=$((failures + 1))
    continue
  }
  if [[ "$capture" != "$expected_args" ]]; then
    printf 'FAIL node-capture value=%s expected=%s actual=%s\n' \
      "$value" "$expected_args" "$capture" >&2
    failures=$((failures + 1))
  else
    printf 'PASS node-capture value=%s argv=%s\n' "$value" "$capture"
  fi

  sandbox_arg_capture=$(runuser -u orca -- env ELECTRON_RUN_AS_NODE="$value" APPDIR="$app_root" \
    "$app_run" -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' -- \
    alpha --no-sandbox omega 2>&1) || {
    printf 'FAIL node-user-sandbox-arg value=%s output=%s\n' "$value" "$sandbox_arg_capture" >&2
    failures=$((failures + 1))
    continue
  }
  if [[ "$sandbox_arg_capture" != "$expected_sandbox_arg" ]]; then
    printf 'FAIL node-user-sandbox-arg value=%s expected=%s actual=%s\n' \
      "$value" "$expected_sandbox_arg" "$sandbox_arg_capture" >&2
    failures=$((failures + 1))
  else
    printf 'PASS node-user-sandbox-arg value=%s argv=%s\n' "$value" "$sandbox_arg_capture"
  fi

  cli_output=$(runuser -u orca -- env ELECTRON_RUN_AS_NODE="$value" APPDIR="$app_root" \
    "$app_run" -e "$cli_bootstrap" -- --help 2>&1) || {
    printf 'FAIL cli-parser value=%s output=%s\n' "$value" "$cli_output" >&2
    failures=$((failures + 1))
    continue
  }
  if [[ "$cli_output" != *'Usage: orca <command> [options]'* ]]; then
    printf 'FAIL cli-parser value=%s output=%s\n' "$value" "$cli_output" >&2
    failures=$((failures + 1))
  else
    printf 'PASS cli-parser value=%s\n' "$value"
  fi
done

gui_root=/tmp/orca-appimage-gui
cp "$app_run" "$gui_root/AppRun"
cp "$app_root/unshare" "$gui_root/unshare"
cat >"$gui_root/orca-ide" <<'EOF'
#!/usr/bin/env bash
printf '%s\0' "$@"
EOF
chmod 755 "$gui_root/AppRun" "$gui_root/unshare" "$gui_root/orca-ide"

for mode in unset empty; do
  if [[ "$mode" == unset ]]; then
    if ! gui_capture=$(runuser -u orca -- env -u ELECTRON_RUN_AS_NODE APPDIR="$gui_root" \
      "$gui_root/AppRun" alpha '' 'two words' 'dollar$sign' 'snowman-☃' --flag=value omega | \
      base64 -w0); then
      printf 'FAIL gui-capture mode=%s actual=command-failed\n' "$mode" >&2
      failures=$((failures + 1))
      continue
    fi
  else
    if ! gui_capture=$(runuser -u orca -- env ELECTRON_RUN_AS_NODE= APPDIR="$gui_root" \
      "$gui_root/AppRun" alpha '' 'two words' 'dollar$sign' 'snowman-☃' --flag=value omega | \
      base64 -w0); then
      printf 'FAIL gui-capture mode=%s actual=command-failed\n' "$mode" >&2
      failures=$((failures + 1))
      continue
    fi
  fi
  gui_expected=$(printf '%s\0' --no-sandbox alpha '' 'two words' 'dollar$sign' 'snowman-☃' \
    --flag=value omega | base64 -w0)
  if [[ "$gui_capture" != "$gui_expected" ]]; then
    printf 'FAIL gui-capture mode=%s expected-base64=%s actual-base64=%s\n' \
      "$mode" "$gui_expected" "$gui_capture" >&2
    failures=$((failures + 1))
  else
    printf 'PASS gui-capture mode=%s argv-base64=%s\n' "$mode" "$gui_capture"
  fi
done

probe_count=0
if [[ -f /tmp/orca-appimage-unshare.log ]]; then
  probe_count=$(wc -l </tmp/orca-appimage-unshare.log)
fi
if [[ "$probe_count" -ne 2 ]]; then
  printf 'FAIL unshare-probe expected=2 actual=%s\n' "$probe_count" >&2
  failures=$((failures + 1))
else
  printf 'PASS unshare-probe count=%s\n' "$probe_count"
fi

if [[ "$failures" -ne 0 ]]; then
  printf 'AppImage CLI sandbox contract failed: %s signal(s)\n' "$failures" >&2
  exit 1
fi

printf 'AppImage CLI sandbox contract passed.\n'
