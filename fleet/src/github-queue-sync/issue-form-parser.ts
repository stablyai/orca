import { parseScopeList } from '../file-boundary-guard/scope-list-parser.ts';
import type { ScopeProblem } from '../file-boundary-guard/scope-list-parser.ts';

/**
 * Bản sao nguyên văn `placeholder:` trong `agent-task.yml` của hungdaitool. Chỉ coi là "chưa điền"
 * khi TOÀN BỘ nội dung trùng mẫu (người điền thật có thể hợp lệ nhắc tới MediaLightbox).
 * Nếu template đổi thì cập nhật ở đây, hoặc truyền `placeholders` riêng vào `parseAgentTaskForm`.
 */
export const DEFAULT_PLACEHOLDERS: Readonly<Record<SectionNumber, string>> = {
  1: 'Khi bấm "Tải lại" trong MediaLightbox của tab Gen, ảnh thumbnail hiển thị lại trong ≤ 1s\nvà `npm test` có thêm 1 case bao phủ hành vi này.',
  2: 'src/components/MediaLightbox.tsx\nscripts/test-shared.mjs',
  3: '- [ ] `npm test && npm run typecheck && npm run build` pass, 0 lỗi\n- [ ] Đã `grep -rl "MediaLightbox" src/` và kiểm tra mọi nơi gọi (Gen + Workflow)\n- [ ] PR có `Closes #<số issue>` và mô tả trước/sau',
  4: '- Không đổi tên/kiểu field trong FormInputData, FlowSettingsSpec, QueueJob, ComfyNodeFields (chỉ thêm field optional)\n- Task area:workflow: `git diff --stat -- src/tabs/gen src/services/flowProtocol.ts src/hooks/useQueueRunner.ts src/components src/state/store.ts` phải rỗng\n- Không chạy lệnh xoá (ĐIỀU 0), không push --force, không sửa .github/\n- Không thêm dependency mới'
};

export type SectionNumber = 1 | 2 | 3 | 4;

export type FormProblemCode =
  | 'missing-section'
  | 'empty-section'
  | 'placeholder-only'
  | 'invalid-scope'
  | 'dod-has-no-command'
  | 'invalid-base-branch';

export interface FormProblem {
  readonly code: FormProblemCode;
  readonly section?: SectionNumber | 'base-branch';
  readonly scopeProblems?: readonly ScopeProblem[];
}

export interface AgentTaskForm {
  readonly objective: string;
  readonly scopePatterns: readonly string[];
  readonly definitionOfDone: string;
  readonly negativeConstraints: string;
  readonly proposedAgent?: string;
  readonly baseBranch: string;
  readonly context?: string;
}

export type FormParseResult =
  | { readonly ok: true; readonly form: AgentTaskForm }
  | { readonly ok: false; readonly problems: readonly FormProblem[] };

/** GitHub ghi `_No response_` cho ô để trống. */
const NO_RESPONSE = '_No response_';
const DEFAULT_BASE_BRANCH = 'main';
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** Issue Form của GitHub render thành `### <label>\n\n<nội dung>` cho từng ô. */
function splitSections(body: string): Map<string, string> {
  const sections = new Map<string, string>();
  const parts = body.replace(/\r\n/g, '\n').split(/^### +/m).slice(1);
  for (const part of parts) {
    const newline = part.indexOf('\n');
    const heading = (newline === -1 ? part : part.slice(0, newline)).trim();
    const content = newline === -1 ? '' : part.slice(newline + 1).trim();
    sections.set(heading, content === NO_RESPONSE ? '' : content);
  }
  return sections;
}

function findSection(sections: Map<string, string>, matches: (heading: string) => boolean): string | undefined {
  for (const [heading, content] of sections) {
    if (matches(heading)) {
      return content;
    }
  }
  return undefined;
}

function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Đọc 4 ô bắt buộc + ô phụ của `agent-task.yml` (blueprint §4.2). Báo mọi lỗi cùng lúc. */
export function parseAgentTaskForm(
  body: string,
  placeholders: Readonly<Record<SectionNumber, string>> = DEFAULT_PLACEHOLDERS
): FormParseResult {
  const sections = splitSections(body);
  const problems: FormProblem[] = [];
  const required = {} as Record<SectionNumber, string>;

  for (const number of [1, 2, 3, 4] as const) {
    const content = findSection(sections, (heading) => heading.startsWith(`${number}.`));
    if (content === undefined) {
      problems.push({ code: 'missing-section', section: number });
    } else if (content === '') {
      problems.push({ code: 'empty-section', section: number });
    } else if (squash(content) === squash(placeholders[number])) {
      problems.push({ code: 'placeholder-only', section: number });
    } else {
      required[number] = content;
    }
  }

  let scopePatterns: readonly string[] = [];
  if (required[2] !== undefined) {
    const scope = parseScopeList(required[2]);
    if (scope.ok) {
      scopePatterns = scope.patterns;
    } else {
      problems.push({ code: 'invalid-scope', section: 2, scopeProblems: scope.problems });
    }
  }
  if (required[3] !== undefined && !/`[^`\n]+`/.test(required[3])) {
    problems.push({ code: 'dod-has-no-command', section: 3 });
  }

  const baseBranch = findSection(sections, (heading) => heading === 'Nhánh gốc') || DEFAULT_BASE_BRANCH;
  // Nhánh gốc do người dùng nhập và sẽ vào `git diff <base>...HEAD`: chặn ký tự lạ và `-` đầu.
  if (!SAFE_BRANCH.test(baseBranch) || baseBranch.includes('..')) {
    problems.push({ code: 'invalid-base-branch', section: 'base-branch' });
  }

  if (problems.length > 0) {
    return { ok: false, problems };
  }
  const proposedAgent = findSection(sections, (heading) => heading === 'Agent đề xuất');
  const context = findSection(sections, (heading) => heading.startsWith('Ngữ cảnh'));
  return {
    ok: true,
    form: {
      objective: required[1],
      scopePatterns,
      definitionOfDone: required[3],
      negativeConstraints: required[4],
      baseBranch,
      ...(proposedAgent ? { proposedAgent } : {}),
      ...(context ? { context } : {})
    }
  };
}
