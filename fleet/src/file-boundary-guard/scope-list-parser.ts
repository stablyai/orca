import { findUnsafeReason, normalizeRepoPath } from './scope-path.ts';
import type { UnsafePathReason } from './scope-path.ts';

/** Blueprint §4.2: "Phạm vi file" tối đa 8 dòng. */
export const MAX_SCOPE_LINES = 8;

export type ScopeProblemCode =
  | 'empty-scope'
  | 'too-many-lines'
  | 'root-double-star'
  | 'negation-unsupported'
  | UnsafePathReason;

export interface ScopeProblem {
  readonly code: ScopeProblemCode;
  /** Số thứ tự dòng (1-based, tính cả dòng trống) — vắng khi lỗi áp cho cả danh sách. */
  readonly line?: number;
  readonly text?: string;
}

export type ScopeParseResult =
  | { readonly ok: true; readonly patterns: readonly string[] }
  | { readonly ok: false; readonly problems: readonly ScopeProblem[] };

/** Người dùng hay gõ `- src/a.ts` hoặc bọc trong dấu backtick — chấp nhận cả hai. */
function cleanScopeLine(raw: string): string {
  let text = raw.trim().replace(/^[-*]\s+/, '');
  if (text.length >= 2 && text.startsWith('`') && text.endsWith('`')) {
    text = text.slice(1, -1);
  }
  return normalizeRepoPath(text);
}

/**
 * Đọc trường "Phạm vi file cho phép sửa" của issue `agent-task.yml`.
 *
 * Cú pháp mẫu: `*` (trong một cấp thư mục), `**` (xuyên thư mục), `?`, và `dir/` nghĩa là mọi file
 * dưới `dir`. Chặn `**` ở gốc repo (kể cả dạng `**` + `/*.ts`) vì nó cho phép "sửa gì cũng được".
 */
export function parseScopeList(text: string): ScopeParseResult {
  const problems: ScopeProblem[] = [];
  const patterns: string[] = [];

  text.split(/\r?\n/).forEach((rawLine, index) => {
    const pattern = cleanScopeLine(rawLine);
    if (pattern === '') {
      return;
    }
    const line = index + 1;
    const unsafe = findUnsafeReason(pattern);
    if (unsafe !== undefined) {
      problems.push({ code: unsafe, line, text: pattern });
    } else if (pattern.startsWith('!')) {
      problems.push({ code: 'negation-unsupported', line, text: pattern });
    } else if (pattern.startsWith('**')) {
      problems.push({ code: 'root-double-star', line, text: pattern });
    } else {
      patterns.push(pattern);
    }
  });

  const nonEmptyLines = text.split(/\r?\n/).filter((line) => line.trim() !== '').length;
  if (nonEmptyLines === 0) {
    problems.push({ code: 'empty-scope' });
  } else if (nonEmptyLines > MAX_SCOPE_LINES) {
    problems.push({ code: 'too-many-lines' });
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, patterns };
}
