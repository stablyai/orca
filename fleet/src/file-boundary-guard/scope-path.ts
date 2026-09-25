export type UnsafePathReason = 'absolute-path' | 'parent-segment';

/**
 * Đưa đường dẫn về dạng git dùng: dấu `/`, không `./` đầu, không `//`.
 * Worker chạy trên Windows nên issue và diff đều có thể lẫn `\`.
 */
export function normalizeRepoPath(raw: string): string {
  let path = raw.trim().replaceAll('\\', '/').replace(/\/{2,}/g, '/');
  while (path.startsWith('./')) {
    path = path.slice(2);
  }
  return path;
}

/** Đường dẫn trong phạm vi task phải nằm TRONG repo: không tuyệt đối, không chui ra bằng `..`. */
export function findUnsafeReason(normalizedPath: string): UnsafePathReason | undefined {
  if (normalizedPath.startsWith('/') || /^[A-Za-z]:/.test(normalizedPath)) {
    return 'absolute-path';
  }
  if (normalizedPath.split('/').includes('..')) {
    return 'parent-segment';
  }
  return undefined;
}
