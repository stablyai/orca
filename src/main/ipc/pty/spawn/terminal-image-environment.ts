import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import {
  ORCA_IMAGE_PROTOCOL_ENV,
  ORCA_IMAGE_PROTOCOL_VALUE,
  ORCA_TERMINAL_IMAGE_VIEWER_ENV
} from '../../../../shared/terminal/images/terminal-image-protocol'
import { resolveTerminalInlineImagesEnabled } from '../../../../shared/terminal/images/terminal-inline-images-settings'

export function applyTerminalImageEnvironment(
  env: Record<string, string>,
  envToDelete: string[],
  agent: TuiAgent | undefined,
  inlineImages: boolean | undefined,
  headlessHost: boolean | undefined
): boolean {
  const viewer = env[ORCA_TERMINAL_IMAGE_VIEWER_ENV]
  delete env[ORCA_TERMINAL_IMAGE_VIEWER_ENV]
  const enabled =
    (viewer === undefined ? !headlessHost : viewer === '1') &&
    resolveTerminalInlineImagesEnabled(inlineImages) &&
    !envToDelete.includes(ORCA_IMAGE_PROTOCOL_ENV)
  if (enabled) {
    env[ORCA_IMAGE_PROTOCOL_ENV] = ORCA_IMAGE_PROTOCOL_VALUE
  } else {
    delete env[ORCA_IMAGE_PROTOCOL_ENV]
    // Older PTY daemons unconditionally stamp the hint.
    if (!envToDelete.includes(ORCA_IMAGE_PROTOCOL_ENV)) {
      envToDelete.push(ORCA_IMAGE_PROTOCOL_ENV)
    }
  }

  // Managed Claude can bypass the shell function and reads this preference at startup.
  if (
    agent === 'claude' &&
    env.CLAUDE_CODE_FORCE_TERMINAL_IMAGES === undefined &&
    process.env.CLAUDE_CODE_FORCE_TERMINAL_IMAGES === undefined &&
    !envToDelete.includes('CLAUDE_CODE_FORCE_TERMINAL_IMAGES')
  ) {
    env.CLAUDE_CODE_FORCE_TERMINAL_IMAGES = enabled ? '1' : '0'
  }
  return enabled
}
