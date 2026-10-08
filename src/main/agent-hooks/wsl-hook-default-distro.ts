export async function resolveWslHookDefaultDistro(
  currentDistro: string | null,
  listDistros: () => Promise<string[]>
): Promise<string | null> {
  if (currentDistro) {
    return currentDistro
  }
  try {
    return (await listDistros())[0] ?? null
  } catch {
    return null
  }
}
