export interface FormSections {
  objective?: string | null;
  scope?: string | null;
  dod?: string | null;
  constraints?: string | null;
  agent?: string | null;
  baseBranch?: string | null;
  context?: string | null;
}

const GOOD: Required<{ [K in keyof FormSections]: string }> = {
  objective: 'Sau khi merge, CI chạy pilot-verify cho SKILL.md và log có dòng ✓.',
  scope: '.github/workflows/ci.yml',
  dod: '- [ ] `npm test && npm run typecheck && npm run build` pass\n- [ ] PR có `Closes #1`',
  constraints: '- Không sửa file khác trong .github/\n- Không chạy lệnh xoá',
  agent: 'claude',
  baseBranch: 'main',
  context: '_No response_'
};

/** Dựng body đúng như GitHub render Issue Form: `### <nhãn>` rồi nội dung. `null` = bỏ hẳn ô đó. */
export function buildIssueBody(overrides: FormSections = {}): string {
  const value = <K extends keyof FormSections>(key: K): string | null =>
    overrides[key] === undefined ? GOOD[key] : (overrides[key] as string | null);
  const blocks: [string, string | null][] = [
    ['1. Mục tiêu đo được', value('objective')],
    ['2. Phạm vi file cho phép sửa', value('scope')],
    ['3. Definition of Done', value('dod')],
    ['4. Ranh giới cấm (Negative Constraints)', value('constraints')],
    ['Agent đề xuất', value('agent')],
    ['Nhánh gốc', value('baseBranch')],
    ['Ngữ cảnh / liên kết (tuỳ chọn)', value('context')]
  ];
  return blocks
    .filter((entry): entry is [string, string] => entry[1] !== null)
    .map(([heading, content]) => `### ${heading}\n\n${content === '' ? '_No response_' : content}`)
    .join('\n\n');
}

export const READY_LABELS: readonly string[] = ['status:ready', 'size:S', 'agent:claude', 'area:infra'];
