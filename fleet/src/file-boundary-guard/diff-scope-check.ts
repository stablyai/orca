import { createScopeMatcher } from './scope-matcher.ts';
import { normalizeRepoPath } from './scope-path.ts';

export interface ScopeCheckInput {
  readonly patterns: readonly string[];
  /** File nằm trong diff đã commit `<base>...HEAD` — đúng thứ PR sẽ chứa. Đây là thứ bị cưỡng chế. */
  readonly committedFiles: readonly string[];
  /** File còn sửa dở trong working tree (chưa commit). Chỉ cảnh báo, không chặn. */
  readonly uncommittedFiles?: readonly string[];
}

export interface ScopeVerdict {
  /** `blocked` → Fleet đặt `status:blocked` kèm comment liệt kê `violations` (blueprint §4.2). */
  readonly status: 'ok' | 'blocked';
  /** File đã commit nhưng nằm ngoài phạm vi, không trùng lặp, sắp xếp ổn định. */
  readonly violations: readonly string[];
  /**
   * File chưa commit nằm ngoài phạm vi. Thực tế hay gặp: `npm run build` làm bẩn `dist/` (đang được
   * git theo dõi ở hungdaitool). Chúng không vào PR nên không chặn, nhưng người xem cần biết.
   */
  readonly warnings: readonly string[];
}

function uniqueSorted(paths: Iterable<string>): string[] {
  return [...new Set(paths)].sort();
}

/**
 * Hàm thuần: cùng đầu vào → cùng kết luận, không chạm git hay đĩa.
 * Đường dẫn được chuẩn hoá (`\` → `/`) nên diff từ Windows và danh sách trong issue so được với nhau.
 */
export function evaluateScope(input: ScopeCheckInput): ScopeVerdict {
  const isAllowed = createScopeMatcher(input.patterns);

  const violations = uniqueSorted(
    input.committedFiles.map(normalizeRepoPath).filter((filePath) => !isAllowed(filePath))
  );
  const alreadyViolating = new Set(violations);
  const warnings = uniqueSorted(
    (input.uncommittedFiles ?? [])
      .map(normalizeRepoPath)
      .filter((filePath) => !isAllowed(filePath) && !alreadyViolating.has(filePath))
  );

  return { status: violations.length > 0 ? 'blocked' : 'ok', violations, warnings };
}
