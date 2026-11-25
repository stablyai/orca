/** `githubSizes`: cap `\\Huge` and the other large sizes the way github.com draws them. */
export type MobileMathTypesetter = (
  value: string,
  display: boolean,
  githubSizes: boolean
) => string | null

/** A native render has no document to draw KaTeX's HTML into; formulas stay as their source. */
export function loadMobileMathTypesetter(): Promise<MobileMathTypesetter | null> {
  return Promise.resolve(null)
}
