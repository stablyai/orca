// A dialog draws in its own window, so its host takes no room in the screen's layout.
export const DIALOG_HOST_STYLE = { position: 'absolute' } as const

// Compose's slot style doesn't reach @expo/ui Text, so dialog titles set the M3 headline themselves.
export const DIALOG_TITLE_STYLE = { typography: 'headlineSmall' } as const
