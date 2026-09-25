import { patternsOverlap } from './path-pattern-overlap.ts';

export type ScopeOverlapResult =
  | { readonly overlap: false }
  | { readonly overlap: true; readonly conflicts: readonly { readonly a: string; readonly b: string }[] };

/**
 * Kiểm tra sự giao nhau giữa hai tập hợp phạm vi file (scope A và scope B).
 * Nếu có bất kỳ cặp pattern nào giao nhau, trả về danh sách tất cả các cặp xung đột đó.
 * Scope rỗng coi như không giao với ai.
 */
export function scopesOverlap(
  scopeA: readonly string[],
  scopeB: readonly string[],
): ScopeOverlapResult {
  if (scopeA.length === 0 || scopeB.length === 0) {
    return { overlap: false };
  }

  const conflicts: { a: string; b: string }[] = [];

  for (const patA of scopeA) {
    for (const patB of scopeB) {
      if (patternsOverlap(patA, patB)) {
        conflicts.push({ a: patA, b: patB });
      }
    }
  }

  if (conflicts.length > 0) {
    return {
      overlap: true,
      conflicts,
    };
  }

  return { overlap: false };
}
