export async function resolveWslDefaultDistro(
  cachedDistro: string | null,
  listDistros: () => Promise<string[]>
): Promise<string | null> {
  if (cachedDistro) {
    return cachedDistro
  }
  try {
    return (await listDistros())[0] ?? null
  } catch {
    return null
  }
}
