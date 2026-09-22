/**
 * The page shows no Remove: it holds neither the host list nor the credential, so the only thing
 * this control could do there is throw `PageHostRemovalUnavailableError`.
 */
export function AuthFailedRemoveAction(_props: { onPress: () => void }): null {
  return null
}
