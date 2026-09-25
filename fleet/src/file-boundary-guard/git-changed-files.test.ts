import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GitRunner } from './git-changed-files.ts';
import {
  listCommittedChanges,
  listUncommittedChanges,
  parseNulSeparatedPaths,
  parsePorcelainPaths
} from './git-changed-files.ts';

function fakeRunner(stdout: string): { run: GitRunner; calls: { args: readonly string[]; cwd: string }[] } {
  const calls: { args: readonly string[]; cwd: string }[] = [];
  const run: GitRunner = async (args, cwd) => {
    calls.push({ args, cwd });
    return stdout;
  };
  return { run, calls };
}

describe('parseNulSeparatedPaths', () => {
  it('tách theo NUL và giữ nguyên tên có khoảng trắng, dấu nháy, tiếng Việt', () => {
    const stdout = 'a b.ts\0docs/Kịch bản "cuối".md\0';
    assert.deepEqual(parseNulSeparatedPaths(stdout), ['a b.ts', 'docs/Kịch bản "cuối".md']);
  });

  it('đầu ra rỗng → mảng rỗng', () => {
    assert.deepEqual(parseNulSeparatedPaths(''), []);
  });
});

describe('parsePorcelainPaths', () => {
  it('bỏ hai ký tự trạng thái và dấu cách, gồm cả file chưa theo dõi (??)', () => {
    const stdout = ' M dist/index.html\0?? scripts/setup-github-labels.mjs\0D  old.ts\0';
    assert.deepEqual(parsePorcelainPaths(stdout), ['dist/index.html', 'scripts/setup-github-labels.mjs', 'old.ts']);
  });
});

describe('listCommittedChanges', () => {
  it('gọi git diff ba chấm với --no-renames và -z, trong đúng cwd', async () => {
    const { run, calls } = fakeRunner('scripts/pilot-verify.mjs\0');
    const files = await listCommittedChanges(run, 'C:/work/tree', 'origin/main');
    assert.deepEqual(files, ['scripts/pilot-verify.mjs']);
    assert.deepEqual(calls, [
      {
        args: ['diff', '--name-only', '--no-renames', '-z', 'origin/main...HEAD', '--'],
        cwd: 'C:/work/tree'
      }
    ]);
  });

  it('từ chối nhánh gốc bắt đầu bằng `-` (chống chèn tuỳ chọn git qua tên nhánh trong issue)', async () => {
    const { run, calls } = fakeRunner('');
    await assert.rejects(listCommittedChanges(run, '.', '--output=pwned'), /không hợp lệ/);
    await assert.rejects(listCommittedChanges(run, '.', ''), /không hợp lệ/);
    assert.equal(calls.length, 0);
  });

  it('lỗi từ git được đẩy lên nguyên vẹn, không nuốt thành "không có thay đổi"', async () => {
    const run: GitRunner = async () => {
      throw new Error('fatal: bad revision');
    };
    await assert.rejects(listCommittedChanges(run, '.', 'nope'), /bad revision/);
  });
});

describe('listUncommittedChanges', () => {
  it('gọi git status porcelain v1 với -z, --no-renames và mọi file chưa theo dõi', async () => {
    const { run, calls } = fakeRunner(' M dist/x.js\0');
    assert.deepEqual(await listUncommittedChanges(run, '/w'), ['dist/x.js']);
    assert.deepEqual(calls[0]?.args, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all']);
  });
});
