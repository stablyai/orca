import {
  DesktopBrowserViewInputSchema,
  type DesktopBrowserViewInput
} from '../../shared/desktop-browser-view-input'

type KeyInput = Extract<DesktopBrowserViewInput, { kind: 'key' }>
type MouseInput = Extract<DesktopBrowserViewInput, { kind: 'mouse'; button: string }>

/** Tracks forwarded presses until a matching release has actually settled. */
export class DesktopBrowserViewInputState {
  private readonly keys = new Map<string, KeyInput>()
  private readonly buttons = new Map<MouseInput['button'], MouseInput>()
  private point = { x: 0, y: 0 }

  constructor(private readonly send: (input: DesktopBrowserViewInput) => Promise<void>) {}

  async dispatch(value: DesktopBrowserViewInput, enabled: boolean): Promise<void> {
    const input = DesktopBrowserViewInputSchema.parse(value)
    const release = (input.kind === 'key' || input.kind === 'mouse') && input.type === 'up'
    if (!enabled && !release) {
      throw new Error('Desktop browser page input is unavailable')
    }
    if (input.kind === 'key') {
      if (input.type === 'down') {
        this.keys.set(input.code, input)
      } else {
        const held = this.keys.get(input.code)
        if (!held && !enabled) {
          return
        }
        await this.send({ ...input, key: held?.key ?? input.key })
        this.keys.delete(input.code)
        return
      }
    } else if (input.kind === 'mouse') {
      this.point = { x: input.x, y: input.y }
      if (input.type === 'down' && input.button !== 'none') {
        this.buttons.set(input.button, input)
      } else if (input.type === 'up') {
        if (!this.buttons.has(input.button) && !enabled) {
          return
        }
        await this.send(input)
        this.buttons.delete(input.button)
        return
      }
    }
    // A rejected command may have reached Chromium, so retain its possible press for cleanup.
    await this.send(input)
  }

  async releaseAll(): Promise<void> {
    const errors: unknown[] = []
    const releases: DesktopBrowserViewInput[] = [
      ...Array.from(this.buttons.values(), (input): MouseInput => ({
        kind: 'mouse',
        type: 'up',
        ...this.point,
        button: input.button,
        buttons: 0,
        modifiers: []
      })),
      ...Array.from(this.keys.values(), (input): KeyInput => ({
        kind: 'key',
        type: 'up',
        key: input.key,
        code: input.code,
        modifiers: []
      }))
    ]
    for (const input of releases) {
      try {
        await this.dispatch(input, false)
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length) {
      throw new AggregateError(errors, 'Releasing desktop browser input failed')
    }
  }
}
