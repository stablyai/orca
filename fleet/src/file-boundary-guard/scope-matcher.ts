import { normalizeRepoPath } from './scope-path.ts';

function escapeRegExpChar(char: string): string {
  return /[\\^$.*+?()[\]{}|/]/.test(char) ? `\\${char}` : char;
}

/**
 * Chỉ hỗ trợ `*`, `**`, `?` (đủ cho "Phạm vi file"); `[abc]` và `{a,b}` được coi là ký tự thường
 * để không ai vô tình mở rộng phạm vi. `dir/` (đuôi `/`) = mọi file dưới `dir`.
 */
function globToRegExp(pattern: string): RegExp {
  const glob = pattern.endsWith('/') ? `${pattern}**` : pattern;
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob.charAt(index);
    if (char === '*' && glob.charAt(index + 1) === '*') {
      // `**/` khớp cả "không có thư mục nào" nên `src/**/x.ts` khớp `src/x.ts`.
      if (glob.charAt(index + 2) === '/') {
        source += '(?:.*/)?';
        index += 2;
      } else {
        source += '.*';
        index += 1;
      }
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += escapeRegExpChar(char);
    }
  }
  return new RegExp(`^${source}$`);
}

/**
 * So khớp PHÂN BIỆT HOA THƯỜNG: git so đường dẫn theo đúng chữ hoa/thường đã theo dõi, và nếu
 * lệch thì thà báo vi phạm để người xem còn hơn lặng lẽ cho qua.
 */
export function createScopeMatcher(patterns: readonly string[]): (filePath: string) => boolean {
  const matchers = patterns.map((pattern) => globToRegExp(normalizeRepoPath(pattern)));
  return (filePath) => {
    const normalized = normalizeRepoPath(filePath);
    return matchers.some((matcher) => matcher.test(normalized));
  };
}
