import {
  hostFrameKindOf,
  type HostFrameIdentity,
  type HostFrameKind
} from './host-frame-navigation-guard'

type PermissionFrame = HostFrameIdentity & { parent?: PermissionFrame | null }

type MainWindowPermissionRequest = {
  isMainFrame?: boolean
  requestingFrame?: PermissionFrame | null
}

/**
 * Main-window permission requests from a plugin's srcdoc iframe, or any frame nested in one, are
 * refused: they share the app's session but never its trust. Identity is what the frame was
 * registered as at creation (host-frame-navigation-guard.ts), so clearing its own window.name does
 * not help, and other host frames such as chat visuals keep their permissions.
 */
export function isPluginFramePermissionRequest(
  details: MainWindowPermissionRequest | undefined,
  kindOf: (frame: HostFrameIdentity) => HostFrameKind | null = hostFrameKindOf
): boolean {
  if (!details || details.isMainFrame === true) {
    return false
  }
  let frame = details.requestingFrame ?? null
  // Bounded walk: frame trees are shallow, and a detached frame throws on access.
  for (let depth = 0; frame && depth < 32; depth += 1) {
    try {
      if (kindOf(frame) === 'plugin-panel') {
        return true
      }
      frame = frame.parent ?? null
    } catch {
      return false
    }
  }
  return false
}
