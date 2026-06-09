export type BundledWarpTheme = {
  label: string
  content: string
}

export const BUNDLED_WARP_THEME_SOURCE_LABEL = 'Warp sample themes'

export const BUNDLED_WARP_THEMES: BundledWarpTheme[] = [
  {
    label: 'Cyber Wave.yaml',
    content:
      'background:\n  top: "#002633"\n  bottom: "#000000"\naccent:\n  left: "#007972"\n  right: "#7b008f"\nforeground: "#ffffff"\ndetails: darker\nterminal_colors:\n  normal:\n    black: "#616161"\n    red: "#ff8272"\n    green: "#b4fa72"\n    yellow: "#fefdc2"\n    blue: "#a5d5fe"\n    magenta: "#ff8ffd"\n    cyan: "#d0d1fe"\n    white: "#f1f1f1"\n  bright:\n    black: "#8e8e8e"\n    red: "#ffc4bd"\n    green: "#d6fcb9"\n    yellow: "#fefdd5"\n    blue: "#c1e3fe"\n    magenta: "#ffb1fe"\n    cyan: "#e5e6fe"\n    white: "#feffff"\n'
  },
  {
    label: 'Dark City.yaml',
    content:
      'background:\n  top: "#0c252d"\n  bottom: "#0c2c35"\naccent: "#e9072d"\nforeground: "#ffffff"\nbackground_image:\n  # background image credit: https://unsplash.com/photos/0eKCOZ11gfk\n  path: warp_bundled/dark_city_bg.jpg\n  opacity: 20\ndetails: darker\nterminal_colors:\n  normal:\n    black: "#616161"\n    red: "#ff8272"\n    green: "#b4fa72"\n    yellow: "#fefdc2"\n    blue: "#a5d5fe"\n    magenta: "#ff8ffd"\n    cyan: "#d0d1fe"\n    white: "#f1f1f1"\n  bright:\n    black: "#8e8e8e"\n    red: "#ffc4bd"\n    green: "#d6fcb9"\n    yellow: "#fefdd5"\n    blue: "#c1e3fe"\n    magenta: "#ffb1fe"\n    cyan: "#e5e6fe"\n    white: "#feffff"\n'
  },
  {
    label: 'Dracula.yaml',
    content:
      'background: "#282a36"\naccent: "#ff79c6"\nforeground: "#f8f8f2"\ndetails: darker\nterminal_colors:\n  normal:\n    black: "#000000"\n    red: "#ff5555"\n    green: "#50fa7b"\n    yellow: "#f1fa8c"\n    blue: "#bd93f9"\n    magenta: "#ff79c6"\n    cyan: "#8be9fd"\n    white: "#bbbbbb"\n  bright:\n    black: "#555555"\n    red: "#ff5555"\n    green: "#50fa7b"\n    yellow: "#f1fa8c"\n    blue: "#caa9fa"\n    magenta: "#ff79c6"\n    cyan: "#8be9fd"\n    white: "#ffffff"\n'
  },
  {
    label: 'Fancy Dracula.yaml',
    content:
      'background:\n  top: "#252630"\n  bottom: "#3d3f4f"\naccent:\n  left: "#bca1f6"\n  right: "#a3e7fc"\nforeground: "#ffffff"\ndetails: darker\nterminal_colors:\n  normal:\n    black: "#000000"\n    red: "#ff5555"\n    green: "#50fa7b"\n    yellow: "#f1fa8c"\n    blue: "#bd93f9"\n    magenta: "#ff79c6"\n    cyan: "#8be9fd"\n    white: "#bbbbbb"\n  bright:\n    black: "#555555"\n    red: "#ff5555"\n    green: "#50fa7b"\n    yellow: "#f1fa8c"\n    blue: "#caa9fa"\n    magenta: "#ff79c6"\n    cyan: "#8be9fd"\n    white: "#ffffff"\n'
  },
  {
    label: 'Gruvbox Dark.yaml',
    content:
      'background: "#282828"\naccent: "#fc802d"\nforeground: "#ebdbb2"\ndetails: darker\nterminal_colors:\n  normal:\n    black: "#282828"\n    red: "#cc241d"\n    green: "#98971a"\n    yellow: "#d79921"\n    blue: "#458588"\n    magenta: "#b16286"\n    cyan: "#689d6a"\n    white: "#a89984"\n  bright:\n    black: "#928374"\n    red: "#fb4934"\n    green: "#b8bb26"\n    yellow: "#fabd2f"\n    blue: "#83a598"\n    magenta: "#d3869b"\n    cyan: "#8ec07c"\n    white: "#ebdbb2"\n'
  },
  {
    label: 'Gruvbox Light.yaml',
    content:
      'background: "#fbf1c7"\naccent: "#ad3b14"\nforeground: "#3c3836"\ndetails: lighter\nterminal_colors:\n  normal:\n    black: "#fbf1c7"\n    red: "#cc241d"\n    green: "#98971a"\n    yellow: "#d79921"\n    blue: "#458588"\n    magenta: "#b16286"\n    cyan: "#689d6a"\n    white: "#7c6f64"\n  bright:\n    black: "#928374"\n    red: "#9d0006"\n    green: "#79740e"\n    yellow: "#b57614"\n    blue: "#076678"\n    magenta: "#8f3f71"\n    cyan: "#427b58"\n    white: "#3c3836"\n'
  },
  {
    label: 'Jellyfish.yaml',
    content:
      'background: "#1b1718"\naccent: "#005386"\nforeground: "#ffffff"\nbackground_image:\n  # background image credit: https://unsplash.com/photos/gGX1fJkmw3k\n  path: warp_bundled/jellyfish_bg.jpg\n  opacity: 30\ndetails: darker\nterminal_colors:\n  normal:\n    black: "#616161"\n    red: "#ff8272"\n    green: "#b4fa72"\n    yellow: "#fefdc2"\n    blue: "#a5d5fe"\n    magenta: "#ff8ffd"\n    cyan: "#d0d1fe"\n    white: "#f1f1f1"\n  bright:\n    black: "#8e8e8e"\n    red: "#ffc4bd"\n    green: "#d6fcb9"\n    yellow: "#fefdd5"\n    blue: "#c1e3fe"\n    magenta: "#ffb1fe"\n    cyan: "#e5e6fe"\n    white: "#feffff"\n'
  },
  {
    label: 'Koi.yaml',
    content:
      'background: "#211719"\naccent: "#ff3131"\nforeground: "#ffffff"\nbackground_image:\n  # background image credit: https://unsplash.com/photos/tQk3y00flv4\n  path: warp_bundled/koi_bg.jpg\n  opacity: 30\ndetails: darker\nterminal_colors:\n  normal:\n    black: "#616161"\n    red: "#ff8272"\n    green: "#b4fa72"\n    yellow: "#fefdc2"\n    blue: "#a5d5fe"\n    magenta: "#ff8ffd"\n    cyan: "#d0d1fe"\n    white: "#f1f1f1"\n  bright:\n    black: "#8e8e8e"\n    red: "#ffc4bd"\n    green: "#d6fcb9"\n    yellow: "#fefdd5"\n    blue: "#c1e3fe"\n    magenta: "#ffb1fe"\n    cyan: "#e5e6fe"\n    white: "#feffff"\n'
  },
  {
    label: 'Leafy.yaml',
    content:
      'background: "#000000"\naccent: "#55972d"\nforeground: "#ffffff"\nbackground_image:\n  # background image credit: https://unsplash.com/photos/W5XTTLpk1-I\n  path: warp_bundled/leafy_bg.jpg\n  opacity: 30\ndetails: darker\nterminal_colors:\n  normal:\n    black: "#616161"\n    red: "#ff8272"\n    green: "#b4fa72"\n    yellow: "#fefdc2"\n    blue: "#a5d5fe"\n    magenta: "#ff8ffd"\n    cyan: "#d0d1fe"\n    white: "#f1f1f1"\n  bright:\n    black: "#8e8e8e"\n    red: "#ffc4bd"\n    green: "#d6fcb9"\n    yellow: "#fefdd5"\n    blue: "#c1e3fe"\n    magenta: "#ffb1fe"\n    cyan: "#e5e6fe"\n    white: "#feffff"\n'
  },
  {
    label: 'Marble.yaml',
    content:
      'background: "#e3e3e3"\naccent: "#585858"\nforeground: "#000000"\nbackground_image:\n  # background image credit: https://unsplash.com/photos/tqu0IOMaiU8\n  path: warp_bundled/marble_bg.jpg\n  opacity: 50\ndetails: lighter\nterminal_colors:\n  normal:\n    black: "#212121"\n    red: "#c30771"\n    green: "#10a778"\n    yellow: "#a89c14"\n    blue: "#008ec4"\n    magenta: "#523c79"\n    cyan: "#20a5ba"\n    white: "#e0e0e0"\n  bright:\n    black: "#212121"\n    red: "#fb007a"\n    green: "#5fd7af"\n    yellow: "#f3e430"\n    blue: "#20bbfc"\n    magenta: "#6855de"\n    cyan: "#4fb8cc"\n    white: "#f1f1f1"\n'
  },
  {
    label: 'Pink City.yaml',
    content:
      'background: "#fbeff6"\naccent: "#e10087"\nforeground: "#000000"\nbackground_image:\n  # background image credit: https://unsplash.com/photos/OrwkD-iWgqg\n  path: warp_bundled/pink_city_bg.jpg\n  opacity: 40\ndetails:\n  custom:\n    overlay_opacity: 0\n    outline_opacity: 12\n    main_text_opacity: 90\n    sub_text_opacity: 60\n    hint_text_opacity: 40\n    disabled_text_opacity: 20\n    foreground_button_opacity: 30\n    accent_button_opacity: 0\n    button_hover_opacity: 10\n    button_click_opacity: 20\n    accent_overlay_opacity: 30\n    light_overlay_opacity: 3\n    snackbar_outline_opacity: 40\n    snackbar_background_opacity: 30\n    snackbar_active_outline_opacity: 20\n    snackbar_active_background_opacity: 30\n    block_selection_opacity: 10\n    find_bar_button_selection_opacity: 25\n    split_pane_divider_opacity: 20\n    active_pane_border_opacity: 70\n    restored_blocks_overlay_opacity: 10\n    keybinding_row_overlay_opacity: 40\n    voltron_search: 10\n    voltron_sidebar: 5\n    welcome_tips_completion_overlay_opacity: 90\n    sign_in_common_questions_overlay_opacity: 95\nterminal_colors:\n  normal:\n    black: "#212121"\n    red: "#c30771"\n    green: "#10a778"\n    yellow: "#a89c14"\n    blue: "#008ec4"\n    magenta: "#523c79"\n    cyan: "#20a5ba"\n    white: "#e0e0e0"\n  bright:\n    black: "#212121"\n    red: "#fb007a"\n    green: "#5fd7af"\n    yellow: "#f3e430"\n    blue: "#20bbfc"\n    magenta: "#6855de"\n    cyan: "#4fb8cc"\n    white: "#f1f1f1"\n'
  },
  {
    label: 'Red Rock.yaml',
    content:
      'background:\n  top: "#342425"\n  bottom: "#182224"\naccent: "#9f4147"\nforeground: "#ffffff"\nbackground_image:\n  # background image credit: https://unsplash.com/photos/2i-JP4tVAp8\n  path: warp_bundled/red_rock_bg.jpg\n  opacity: 30\ndetails: darker\nterminal_colors:\n  normal:\n    black: "#616161"\n    red: "#ff8272"\n    green: "#b4fa72"\n    yellow: "#fefdc2"\n    blue: "#a5d5fe"\n    magenta: "#ff8ffd"\n    cyan: "#d0d1fe"\n    white: "#f1f1f1"\n  bright:\n    black: "#8e8e8e"\n    red: "#ffc4bd"\n    green: "#d6fcb9"\n    yellow: "#fefdd5"\n    blue: "#c1e3fe"\n    magenta: "#ffb1fe"\n    cyan: "#e5e6fe"\n    white: "#feffff"\n'
  },
  {
    label: 'Snowy.yaml',
    content:
      'background:\n  top: "#ffffff"\n  bottom: "#dee6eb"\naccent: "#647e90"\nforeground: "#000000"\nbackground_image:\n  # background image credit: https://unsplash.com/photos/d3pTF3r_hwY\n  path: warp_bundled/snowy_bg.jpg\n  opacity: 20\ndetails: lighter\nterminal_colors:\n  normal:\n    black: "#212121"\n    red: "#c30771"\n    green: "#10a778"\n    yellow: "#a89c14"\n    blue: "#008ec4"\n    magenta: "#523c79"\n    cyan: "#20a5ba"\n    white: "#e0e0e0"\n  bright:\n    black: "#212121"\n    red: "#fb007a"\n    green: "#5fd7af"\n    yellow: "#f3e430"\n    blue: "#20bbfc"\n    magenta: "#6855de"\n    cyan: "#4fb8cc"\n    white: "#f1f1f1"\n'
  },
  {
    label: 'Solarized Dark.yaml',
    content:
      'background: "#002b36"\naccent: "#cb4b16"\nforeground: "#f8f8f2"\ndetails: darker\nterminal_colors:\n  normal:\n    black: "#073642"\n    red: "#dc322f"\n    green: "#859900"\n    yellow: "#b58900"\n    blue: "#268bd2"\n    magenta: "#d33682"\n    cyan: "#2aa198"\n    white: "#eee8d5"\n  bright:\n    black: "#002b36"\n    red: "#cb4b16"\n    green: "#586e75"\n    yellow: "#657b83"\n    blue: "#839496"\n    magenta: "#6c71c4"\n    cyan: "#93a1a1"\n    white: "#fdf6e3"\n'
  },
  {
    label: 'Solarized Light.yaml',
    content:
      'background: "#fdf6e3"\naccent: "#66b5a9"\nforeground: "#586e75"\ndetails: lighter\nterminal_colors:\n  normal:\n    black: "#073642"\n    red: "#dc322f"\n    green: "#859900"\n    yellow: "#b58900"\n    blue: "#268bd2"\n    magenta: "#d33682"\n    cyan: "#2aa198"\n    white: "#eee8d5"\n  bright:\n    black: "#002b36"\n    red: "#cb4b16"\n    green: "#586e75"\n    yellow: "#657b83"\n    blue: "#839496"\n    magenta: "#6c71c4"\n    cyan: "#93a1a1"\n    white: "#fdf6e3"\n'
  },
  {
    label: 'Warp Dark.yaml',
    content:
      'background: "#000000"\naccent: "#00c2ff"\nforeground: "#ffffff"\ndetails: darker\nterminal_colors:\n  normal:\n    black: "#616161"\n    red: "#ff8272"\n    green: "#b4fa72"\n    yellow: "#fefdc2"\n    blue: "#a5d5fe"\n    magenta: "#ff8ffd"\n    cyan: "#d0d1fe"\n    white: "#f1f1f1"\n  bright:\n    black: "#8e8e8e"\n    red: "#ffc4bd"\n    green: "#d6fcb9"\n    yellow: "#fefdd5"\n    blue: "#c1e3fe"\n    magenta: "#ffb1fe"\n    cyan: "#e5e6fe"\n    white: "#feffff"\n'
  },
  {
    label: 'Warp Light.yaml',
    content:
      'background: "#ffffff"\naccent: "#00c2ff"\nforeground: "#111111"\ndetails: lighter\nterminal_colors:\n  normal:\n    black: "#212121"\n    red: "#c30771"\n    green: "#10a778"\n    yellow: "#a89c14"\n    blue: "#008ec4"\n    magenta: "#523c79"\n    cyan: "#20a5ba"\n    white: "#e0e0e0"\n  bright:\n    black: "#212121"\n    red: "#fb007a"\n    green: "#5fd7af"\n    yellow: "#f3e430"\n    blue: "#20bbfc"\n    magenta: "#6855de"\n    cyan: "#4fb8cc"\n    white: "#f1f1f1"\n'
  },
  {
    label: 'Warp.yaml',
    content:
      'accent: "#5299bf"\nbackground: "#061229"\ndetails: darker\nforeground: "#b8bbc2"\nbackground_image:\n  path: warp_bundled/warp.jpg\n  opacity: 60\n\nterminal_colors:\n  bright:\n    black: "#717885"\n    blue: "#9a99a3"\n    cyan: "#b08060"\n    green: "#2a3448"\n    magenta: "#dbdde0"\n    red: "#f0a000"\n    white: "#ffffff"\n    yellow: "#4d5666"\n  normal:\n    black: "#061229"\n    blue: "#5299bf"\n    cyan: "#72b9bf"\n    green: "#99bf52"\n    magenta: "#9989cc"\n    red: "#d07346"\n    white: "#b8bbc2"\n    yellow: "#fbd461"\n'
  },
  {
    label: 'Willow Dream.yaml',
    content:
      'background:\n  top: "#206169"\n  bottom: "#022f27"\naccent:\n  left: "#f9aea8"\n  right: "#dd6258"\nforeground: "#ffffff"\ndetails: darker\nterminal_colors:\n  normal:\n    black: "#616161"\n    red: "#ff8272"\n    green: "#b4fa72"\n    yellow: "#fefdc2"\n    blue: "#a5d5fe"\n    magenta: "#ff8ffd"\n    cyan: "#d0d1fe"\n    white: "#f1f1f1"\n  bright:\n    black: "#8e8e8e"\n    red: "#ffc4bd"\n    green: "#d6fcb9"\n    yellow: "#fefdd5"\n    blue: "#c1e3fe"\n    magenta: "#ffb1fe"\n    cyan: "#e5e6fe"\n    white: "#feffff"\n'
  }
]
