import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Bộ chạy git được tiêm vào để test không cần git thật. Trả về stdout nguyên văn. */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<string>;

/**
 * Mảng argv + `shell: false` (blueprint 1.4): không có chỗ nào để dấu `"`, `&` hay khoảng trắng
 * trong tên nhánh/đường dẫn bị shell hiểu sai.
 */
export const runGitWithExecFile: GitRunner = async (args, cwd) => {
  const { stdout } = await execFileAsync('git', [...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  });
  return stdout;
};

/** Đầu ra `-z`: các đường dẫn ngăn cách bằng NUL, không bị git bọc dấu nháy dù có ký tự tiếng Việt. */
export function parseNulSeparatedPaths(stdout: string): string[] {
  return stdout.split('\0').filter((entry) => entry !== '');
}

/**
 * `git status --porcelain=v1 -z --no-renames`: mỗi mục là `XY <path>`. Với `--no-renames` không có
 * trường "đường dẫn cũ" phụ nên mỗi mục NUL-terminated đúng một đường dẫn.
 */
export function parsePorcelainPaths(stdout: string): string[] {
  return parseNulSeparatedPaths(stdout).map((entry) => entry.slice(3));
}

function assertSafeRef(baseRef: string): void {
  // Ref bắt đầu bằng `-` sẽ bị git hiểu là tuỳ chọn (option injection qua tên nhánh trong issue).
  if (baseRef === '' || baseRef.startsWith('-')) {
    throw new Error(`Nhánh gốc không hợp lệ: "${baseRef}"`);
  }
}

/**
 * File PR sẽ chứa: `git diff --name-only <base>...HEAD` (ba chấm = so với merge-base, đúng như
 * PR trên GitHub). `--no-renames` để đổi tên hiện thành xoá + thêm: cả đường dẫn cũ lẫn mới đều
 * bị kiểm, agent không lách được bằng cách "đổi tên" file ngoài phạm vi.
 */
export async function listCommittedChanges(run: GitRunner, cwd: string, baseRef: string): Promise<string[]> {
  assertSafeRef(baseRef);
  const stdout = await run(['diff', '--name-only', '--no-renames', '-z', `${baseRef}...HEAD`, '--'], cwd);
  return parseNulSeparatedPaths(stdout);
}

/** File đang sửa dở trong working tree, gồm cả file chưa được theo dõi. */
export async function listUncommittedChanges(run: GitRunner, cwd: string): Promise<string[]> {
  const stdout = await run(['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all'], cwd);
  return parsePorcelainPaths(stdout);
}
