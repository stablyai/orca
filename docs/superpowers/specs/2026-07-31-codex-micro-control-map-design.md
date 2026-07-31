# Codex Micro Control Map Design

## Goal

Replace opaque control IDs as the primary mapping labels with an accessible visual map and descriptive physical names, while retaining IDs for diagnostics.

## Approved defaults

- Original monochrome schematic; no vendor photo or third-party asset.
- Interactive highlighting between the schematic and mapping rows.
- Fixed positional labels; no user-defined control names.
- Joystick/radar directions shown as context, but not configurable in this phase.

## Physical layout

The schematic follows the official top-view hardware layout and the observed sequential IDs in proposed row-major order. Physical acceptance must confirm each ID-to-position pairing before the draft PR is marked ready:

- Dial: `ENC_CC`, `ENC_CW`, `ENC_CLK`.
- Top agent keys: `AG00`, `AG01`.
- Four middle agent keys: `AG02`–`AG05`.
- Four lower command keys: `ACT06`–`ACT09`.
- Bottom controls: `ACT10` touch control, `ACT11` wide command key, `ACT12` bottom-right command key.
- The planar joystick is shown with directional arrows and no mapping target because radar dispatch remains a Phase 1 non-goal.

## Interaction

- Hovering or focusing a mapping row highlights its physical control.
- Activating a schematic control focuses the matching action selector.
- Dial counterclockwise, clockwise, and press are separately selectable.
- All diagram controls are keyboard reachable and have descriptive accessible names.
- Raw IDs remain visible as secondary monospace metadata.

## Visual rules

- Inline SVG only; no downloaded/runtime image.
- Use Orca theme tokens through existing utility classes: background/card, muted, border, accent, foreground, and ring.
- No hardcoded colors, decorative color, new shadows, or custom CSS file.
- The schematic scales within the settings column and remains usable in light and dark themes.

## Labels

Labels describe physical position rather than removable keycap artwork. Examples:

- `AG00`: Top-left agent key
- `AG05`: Middle-right agent key
- `ACT06`: Lower-left command key
- `ACT11`: Wide command key
- `ENC_CW`: Dial · clockwise

## Verification

- Component test proves descriptive labels and diagram semantics render.
- Interaction test proves activating a diagram control focuses its matching selector.
- Existing mapping, connection-state, localization, lint, typecheck, build, and full test gates remain green.
- macOS screenshots verify light and dark rendering before the draft PR is updated.
