import type { AiVaultServiceClientOptions } from './session-scanner-service-client-state'

type RootAnswerChild = Pick<
  ReturnType<AiVaultServiceClientOptions['processFactory']>,
  'connected' | 'send'
>

/** The parent's half of `requestSessionSearchRoots`; a child replaced meanwhile gets no answer. */
export function answerAiVaultServiceSessionSearchRoots(
  child: RootAnswerChild | null,
  id: number,
  options: AiVaultServiceClientOptions,
  currentChild: () => RootAnswerChild | null
): void {
  const resolve = options.resolveSessionSearchRoots
  void Promise.resolve()
    .then(() => (resolve ? resolve() : (options.init().sessionSearch?.roots ?? null)))
    .catch(() => null)
    .then((roots) => {
      if (child && currentChild() === child && child.connected) {
        child.send({ type: 'sessionSearchRoots', id, roots }, () => undefined)
      }
    })
}
