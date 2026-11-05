import type { MobileMathTypesetter } from './mobile-markdown-math-typesetter'

/** KaTeX and its fonts load with the first formula a page shows. */
export async function loadMobileMathTypesetter(): Promise<MobileMathTypesetter | null> {
  const { typesetMobileMath } = await import('./mobile-markdown-math-katex')
  return typesetMobileMath
}
