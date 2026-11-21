#!/usr/bin/env bash
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true ]]
# The isolated X server owns exactly one nested compositor window.
mapfile -t windows < <(xwininfo -root -tree | awk '$2 == "\"gnome-shell\":" {print $1}')
[[ ${#windows[@]} -eq 1 ]]
xdotool windowmap --sync "${windows[0]}"
xdotool windowfocus --sync "${windows[0]}"
read -r width height < <(xwininfo -id "${windows[0]}" | awk '$1 == "Width:" {w=$2} $1 == "Height:" {print w,$2}')
# The native spec opens a single terminal; a seat click activates its Wayland client.
xdotool mousemove --window "${windows[0]}" "$((width / 2))" "$((height / 2))" click 1
