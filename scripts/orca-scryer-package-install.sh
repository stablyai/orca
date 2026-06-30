#!/usr/bin/env bash
set -euo pipefail

repo_dir="${ORCA_SCRYER_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
artifact_dir="${ORCA_SCRYER_ARTIFACT_DIR:-$repo_dir/dist}"
release_dir="${ORCA_SCRYER_RELEASE_DIR:-$repo_dir/.git/orca-scryer-sync/releases}"
package_command="${ORCA_SCRYER_PACKAGE_COMMAND:-corepack pnpm run build:linux}"
auto_install="${ORCA_SCRYER_AUTO_INSTALL:-0}"
install_kind="${ORCA_SCRYER_INSTALL_KIND:-appimage}"

run() {
  echo "+ $*"
  "$@"
}

escape_sed_replacement() {
  printf '%s' "$1" | sed -e 's/[&|\\]/\\&/g'
}

upsert_desktop_key() {
  local file="$1"
  local key="$2"
  local value="$3"
  local escaped_value

  escaped_value="$(escape_sed_replacement "$value")"
  if grep -q "^$key=" "$file"; then
    sed -i "s|^$key=.*|$key=$escaped_value|" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

ensure_pnpm_shim() {
  if command -v pnpm >/dev/null 2>&1; then
    return 0
  fi
  if ! command -v corepack >/dev/null 2>&1; then
    echo "Neither pnpm nor corepack was found. Cannot run the package command." >&2
    exit 1
  fi

  local shim_dir="$release_path/.bin"
  run mkdir -p "$shim_dir"
  cat > "$shim_dir/pnpm" <<'SHIM'
#!/usr/bin/env bash
set -euo pipefail
exec corepack pnpm "$@"
SHIM
  run chmod 0755 "$shim_dir/pnpm"
  export PATH="$shim_dir:$PATH"
}

require_clean_tree() {
  if [[ "${ORCA_SCRYER_ALLOW_DIRTY_PACKAGE:-0}" == "1" ]]; then
    return 0
  fi

  if [[ -n "$(git -C "$repo_dir" status --porcelain)" ]]; then
    echo "Working tree is dirty. Refusing to package a release from mixed files." >&2
    echo "Set ORCA_SCRYER_ALLOW_DIRTY_PACKAGE=1 only for manual debugging builds." >&2
    exit 1
  fi
}

latest_artifacts() {
  local marker="$1"
  find "$artifact_dir" -maxdepth 1 -type f -newer "$marker" \
    \( -name '*.AppImage' -o -name '*.deb' \) -print | sort
}

fallback_artifacts() {
  find "$artifact_dir" -maxdepth 1 -type f \
    \( -name '*.AppImage' -o -name '*.deb' \) -print | sort
}

select_artifact() {
  local kind="$1"
  shift
  local artifact

  case "$kind" in
    appimage)
      for artifact in "$@"; do
        [[ "$artifact" == *.AppImage ]] && {
          printf '%s\n' "$artifact"
          return 0
        }
      done
      ;;
    deb)
      for artifact in "$@"; do
        [[ "$artifact" == *.deb ]] && {
          printf '%s\n' "$artifact"
          return 0
        }
      done
      ;;
    auto)
      select_artifact appimage "$@" || select_artifact deb "$@"
      return $?
      ;;
    *)
      echo "Unsupported ORCA_SCRYER_INSTALL_KIND='$kind'. Use appimage, deb, or auto." >&2
      return 1
      ;;
  esac

  echo "No '$kind' artifact was produced under $artifact_dir." >&2
  return 1
}

install_appimage() {
  local artifact="$1"
  local install_path="${ORCA_SCRYER_APPIMAGE_INSTALL_PATH:-$HOME/.local/share/orca-scryer/orca-linux.AppImage}"
  local symlink_path="${ORCA_SCRYER_APPIMAGE_SYMLINK:-$HOME/.local/bin/orca}"
  local desktop_launcher="${ORCA_SCRYER_APPIMAGE_DESKTOP_LAUNCHER:-$HOME/.local/bin/orca-app}"
  local cli_launcher="${ORCA_SCRYER_APPIMAGE_CLI_LAUNCHER:-$HOME/.local/bin/orca-app-cli}"
  local appdir_root="${ORCA_SCRYER_APPDIR_ROOT:-$HOME/Applications/Orca}"
  local current_appdir="${ORCA_SCRYER_CURRENT_APPDIR:-$appdir_root/current.AppDir}"
  local appdir_name="${ORCA_SCRYER_APPDIR_NAME:-orca-scryer-$short_commit.AppDir}"
  local appdir_path="$appdir_root/$appdir_name"
  local desktop_file="${ORCA_SCRYER_APPIMAGE_DESKTOP_FILE:-$HOME/.local/share/applications/orca-appimage.desktop}"

  run mkdir -p "$(dirname "$install_path")" "$(dirname "$symlink_path")" "$(dirname "$desktop_launcher")" "$(dirname "$cli_launcher")" "$(dirname "$desktop_file")" "$appdir_root"
  run cp -f "$artifact" "$install_path"
  run chmod 0755 "$install_path"
  run ln -sfn "$install_path" "$symlink_path"

  local extract_dir
  extract_dir="$(mktemp -d)"
  (
    cd "$extract_dir"
    "$install_path" --appimage-extract >/dev/null
  )
  run rm -rf "$appdir_path"
  run mv "$extract_dir/squashfs-root" "$appdir_path"
  run rm -rf "$extract_dir"
  run ln -sfn "$appdir_path" "$current_appdir"

  local cli_entry="$appdir_path/resources/bin/orca"
  if [[ ! -f "$cli_entry" ]]; then
    echo "Extracted AppDir is missing the Orca CLI entrypoint: $cli_entry" >&2
    exit 1
  fi
  run chmod 0755 "$cli_entry"

  cat > "$desktop_launcher" <<LAUNCHER
#!/usr/bin/env bash
set -euo pipefail
APPDIR="$current_appdir"
unset ELECTRON_RUN_AS_NODE
unset ORCA_TERMINAL_HANDLE ORCA_TAB_ID ORCA_PANE_KEY ORCA_WORKTREE_ID ORCA_APP_VERSION ORCA_SHELL_READY_MARKER
if [[ -x "\$APPDIR/orca-ide" ]]; then
  exec "\$APPDIR/orca-ide" --no-sandbox "\$@"
elif [[ -x "\$APPDIR/orca" ]]; then
  exec "\$APPDIR/orca" --no-sandbox "\$@"
elif [[ -x "\$APPDIR/AppRun" ]]; then
  exec "\$APPDIR/AppRun" --no-sandbox "\$@"
fi
echo "Unable to locate Orca executable in \$APPDIR" >&2
exit 1
LAUNCHER
  run chmod 0755 "$desktop_launcher"

  cat > "$cli_launcher" <<LAUNCHER
#!/usr/bin/env bash
set -euo pipefail
APPDIR="$current_appdir"
exec bash "\$APPDIR/resources/bin/orca" "\$@"
LAUNCHER
  run chmod 0755 "$cli_launcher"

  echo "Installed Orca AppImage at $install_path"
  echo "Extracted Orca AppDir at $appdir_path"
  echo "Updated current AppDir symlink at $current_appdir"
  echo "Updated launcher symlink at $symlink_path"
  echo "Updated CLI launcher at $cli_launcher"

  local app_desktop
  app_desktop="$(find "$appdir_path" -maxdepth 1 -type f -name '*.desktop' | sort | head -n 1 || true)"
  if [[ -n "$app_desktop" ]]; then
    run cp -f "$app_desktop" "$desktop_file"
  else
    cat > "$desktop_file" <<DESKTOP
[Desktop Entry]
Name=Orca
Terminal=false
Type=Application
StartupWMClass=Orca
Comment=Next-gen IDE for parallel agentic development
Categories=Utility;Development;
DESKTOP
  fi

  local icon_name=""
  local icon_path=""
  if [[ -n "$app_desktop" ]]; then
    icon_name="$(sed -n 's/^Icon=//p' "$app_desktop" | head -n 1)"
  fi
  if [[ -n "$icon_name" && "$icon_name" == /* && -f "$icon_name" ]]; then
    icon_path="$icon_name"
  elif [[ -n "$icon_name" ]]; then
    for ext in png svg xpm; do
      if [[ -f "$appdir_path/$icon_name.$ext" ]]; then
        icon_path="$current_appdir/$icon_name.$ext"
        break
      fi
    done
  fi
  if [[ -z "$icon_path" ]]; then
    local fallback_icon
    fallback_icon="$(find "$appdir_path" -maxdepth 1 -type f \( -name '*.png' -o -name '*.svg' -o -name '*.xpm' \) | sort | head -n 1 || true)"
    if [[ -n "$fallback_icon" ]]; then
      icon_path="$current_appdir/$(basename "$fallback_icon")"
    fi
  fi

  upsert_desktop_key "$desktop_file" Exec "$desktop_launcher %U"
  if [[ -n "$icon_path" ]]; then
    upsert_desktop_key "$desktop_file" Icon "$icon_path"
  fi
  echo "Updated desktop launcher at $desktop_launcher"
  echo "Updated desktop file at $desktop_file"
}

install_deb() {
  local artifact="$1"
  if [[ -n "${ORCA_SCRYER_DEB_INSTALL_COMMAND:-}" ]]; then
    ORCA_SCRYER_DEB_ARTIFACT="$artifact" bash -lc "$ORCA_SCRYER_DEB_INSTALL_COMMAND"
    return 0
  fi

  if command -v sudo >/dev/null 2>&1; then
    run sudo apt install -y "$artifact"
  else
    run dpkg -i "$artifact"
  fi
}

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Ubuntu/Linux packaging is only supported on Linux hosts." >&2
  exit 1
fi

if ! git -C "$repo_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Not a git repository: $repo_dir" >&2
  exit 1
fi

require_clean_tree

branch="$(git -C "$repo_dir" branch --show-current)"
commit="$(git -C "$repo_dir" rev-parse HEAD)"
short_commit="$(git -C "$repo_dir" rev-parse --short=12 HEAD)"
timestamp="$(date +%Y%m%d-%H%M%S)"
safe_branch="${branch//\//-}"
release_name="orca-scryer-${safe_branch:-detached}-$short_commit-$timestamp"
release_path="$release_dir/$release_name"
marker="$release_path/.build-start"

run mkdir -p "$artifact_dir" "$release_path"
run touch "$marker"
ensure_pnpm_shim

echo "Packaging Orca release from $branch@$short_commit"
(
  cd "$repo_dir"
  export ORCA_SCRYER_ARTIFACT_DIR="$artifact_dir"
  export ORCA_SCRYER_RELEASE_BRANCH="$branch"
  export ORCA_SCRYER_RELEASE_COMMIT="$commit"
  export ORCA_SCRYER_RELEASE_NAME="$release_name"
  bash -lc "$package_command"
)

mapfile -t artifacts < <(latest_artifacts "$marker")
if [[ "${#artifacts[@]}" -eq 0 ]]; then
  mapfile -t artifacts < <(fallback_artifacts)
fi

if [[ "${#artifacts[@]}" -eq 0 ]]; then
  echo "No Ubuntu artifacts found under $artifact_dir after packaging." >&2
  exit 1
fi

for artifact in "${artifacts[@]}"; do
  run cp -f "$artifact" "$release_path/"
done

{
  printf 'ORCA_SCRYER_RELEASE_BRANCH=%s\n' "$branch"
  printf 'ORCA_SCRYER_RELEASE_COMMIT=%s\n' "$commit"
  printf 'ORCA_SCRYER_RELEASE_NAME=%s\n' "$release_name"
  printf 'ORCA_SCRYER_RELEASE_PATH=%s\n' "$release_path"
} > "$release_path/manifest.env"

echo "Packaged artifacts:"
printf '  %s\n' "${artifacts[@]}"
echo "Release bundle: $release_path"

if [[ "$auto_install" != "1" ]]; then
  echo "Skipping local install because ORCA_SCRYER_AUTO_INSTALL is not 1."
  exit 0
fi

selected_artifact="$(select_artifact "$install_kind" "${artifacts[@]}")"
case "$selected_artifact" in
  *.AppImage)
    install_appimage "$selected_artifact"
    ;;
  *.deb)
    install_deb "$selected_artifact"
    ;;
  *)
    echo "Do not know how to install artifact: $selected_artifact" >&2
    exit 1
    ;;
esac
