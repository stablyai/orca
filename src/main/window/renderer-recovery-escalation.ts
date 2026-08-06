/** How Orca should answer a renderer loss once auto-recovery is off the table. */
export type RendererRecoveryAction = 'relaunch' | 'reload'

/** What the user picked in the recovery dialog. */
export type RendererRecoveryPromptResponse = RendererRecoveryAction | 'quit'

export type RendererRecoveryPromptPlan = {
  buttons: string[]
  defaultId: number
  cancelId: number
  message: string
  detail: string
  /** Response index -> action, so callers never hardcode button positions. */
  responses: RendererRecoveryPromptResponse[]
}

/**
 * `launch-failed` means the renderer process never spawned (sandbox, AV, or
 * broken install). Reloading reuses the same webContents, so it can only burn
 * the circuit breaker and leave a permanently blank window — only a fresh app
 * process can recover.
 */
export function getRendererRecoveryAction(reason: string | undefined): RendererRecoveryAction {
  return reason === 'launch-failed' ? 'relaunch' : 'reload'
}

export function planRendererRecoveryPrompt(input: {
  action: RendererRecoveryAction
  recentRecoveryCount: number
}): RendererRecoveryPromptPlan {
  if (input.action === 'relaunch') {
    return {
      buttons: ['Restart Orca', 'Reload', 'Quit'],
      defaultId: 0,
      cancelId: 2,
      message: 'Orca could not start its window process.',
      detail:
        'The window process failed to launch, so reloading it cannot help. Restarting Orca gives it a fresh process. This is often caused by antivirus interference, a sandbox restriction, or a damaged installation.',
      responses: ['relaunch', 'reload', 'quit']
    }
  }
  return {
    buttons: ['Reload', 'Quit'],
    defaultId: 0,
    cancelId: 1,
    message: 'The app window crashed repeatedly and stopped reloading automatically.',
    detail: `Orca tried to recover ${input.recentRecoveryCount} times in a row without success. This is often a graphics-driver or installation problem. Reload to try again, or quit and relaunch Orca.`,
    responses: ['reload', 'quit']
  }
}

/**
 * Keeps at most one recovery dialog on screen. Scoped to "a prompt is up right
 * now", never "we prompted once": a launch failure that lands after the user
 * answered must get its own prompt, or the window stays blank with no recovery
 * affordance at all.
 */
export class RendererRecoveryPromptGate {
  private showing = false

  /** Resolves undefined when a prompt is already on screen. */
  async show<T>(showPrompt: () => Promise<T>): Promise<T | undefined> {
    if (this.showing) {
      return undefined
    }
    this.showing = true
    try {
      return await showPrompt()
    } finally {
      this.showing = false
    }
  }
}
