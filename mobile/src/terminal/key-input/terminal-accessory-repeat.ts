export const TERMINAL_ACCESSORY_REPEAT_DELAY_MS = 400
export const TERMINAL_ACCESSORY_REPEAT_INTERVAL_MS = 45

type TerminalAccessoryRepeatSender<TInput> = (input: TInput) => Promise<boolean>
type TerminalAccessoryRepeatSendToTerminal<TInput> = (
  input: TInput,
  targetHandle: string,
  isDeliveryTargetCurrent: () => boolean
) => Promise<boolean>

export function createTerminalAccessoryRepeatSender<TInput>(
  targetHandle: string | null,
  isDeliveryTargetCurrent: (targetHandle: string) => boolean,
  sendToTerminal: TerminalAccessoryRepeatSendToTerminal<TInput>
): TerminalAccessoryRepeatSender<TInput> {
  return (input) => {
    if (!targetHandle || !isDeliveryTargetCurrent(targetHandle)) {
      return Promise.resolve(false)
    }
    return sendToTerminal(input, targetHandle, () => isDeliveryTargetCurrent(targetHandle))
  }
}

export function createTerminalAccessoryRepeatController<TInput>() {
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  const stop = () => {
    generation += 1
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  const cancel = stop

  const start = (
    input: TInput,
    send: TerminalAccessoryRepeatSender<TInput>,
    firstRepeatDelayMs?: number
  ) => {
    stop()
    const activeGeneration = generation
    const startedAt = Date.now()
    let nextRepeatDelayMs = firstRepeatDelayMs

    const sendNext = () => {
      timer = null
      if (generation !== activeGeneration) {
        return
      }
      void send(input).then(
        (sent) => {
          if (sent && generation === activeGeneration) {
            const delayMs =
              nextRepeatDelayMs === undefined
                ? TERMINAL_ACCESSORY_REPEAT_INTERVAL_MS
                : Math.min(
                    nextRepeatDelayMs,
                    Math.max(0, nextRepeatDelayMs - (Date.now() - startedAt))
                  )
            nextRepeatDelayMs = undefined
            timer = setTimeout(sendNext, delayMs)
          }
        },
        () => undefined
      )
    }

    sendNext()
  }

  return { cancel, start, stop }
}
