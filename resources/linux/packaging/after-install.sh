#!/bin/bash
# Why: register the bundled `orca-ide` CLI on PATH at package-install time.
# The in-app "Install CLI" action (CliInstaller) can never run on a headless
# server, so without this symlink `orca serve` is unreachable from the shell on
# the exact hosts that need it most. deb/rpm both run this after unpacking.
#
# The shim resolves the real app by walking up from its own location, so a
# symlink works. We discover the install dir instead of hardcoding /opt/Orca
# because electron-builder's directory name can vary by productName sanitization.
set -e

link="/usr/bin/orca-ide"

for dir in /opt/Orca /opt/orca-ide /opt/orca; do
  sandbox="$dir/chrome-sandbox"
  if [ -f "$sandbox" ]; then
    # Why: this custom postinst replaces electron-builder's default script, so
    # it must preserve Chromium's sandbox repair for normal desktop users.
    userns_available=1
    if ! { [ -L /proc/self/ns/user ] && unshare --user true; }; then
      userns_available=0
    fi
    if [ -r /proc/sys/kernel/unprivileged_userns_clone ] &&
      [ "$(cat /proc/sys/kernel/unprivileged_userns_clone)" != "1" ]; then
      userns_available=0
    fi
    if [ -r /proc/sys/user/max_user_namespaces ]; then
      max_user_namespaces="$(cat /proc/sys/user/max_user_namespaces)"
      case "$max_user_namespaces" in
        '' | *[!0-9]*)
          userns_available=0
          ;;
        *)
          if [ "$max_user_namespaces" -le 0 ]; then
            userns_available=0
          fi
          ;;
      esac
    fi

    if [ "$userns_available" -eq 1 ]; then
      chmod 0755 "$sandbox" || true
    else
      chmod 4755 "$sandbox" || true
    fi
  fi

  shim="$dir/resources/bin/orca-ide"
  if [ -x "$shim" ]; then
    # Only manage our own symlink; never clobber an unrelated /usr/bin/orca-ide.
    if [ ! -e "$link" ] || [ -L "$link" ]; then
      ln -sf "$shim" "$link"
    fi
    break
  fi
done

exit 0
