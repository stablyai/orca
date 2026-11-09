import { uiText } from '../settings/NativeUi';
import { lucideColorFilter } from '../settings/LucideColor';
import { AgentDesktop, AgentListRow, agentKind, agentNeedsAttention, agentPreview, agentRowRevision, agentTimeAgo } from './AgentListModel';

const ROW_TEXT_INSET = 40;
const WORKER_INDENT = 22;
const ACTIVITY_AMBER = '#eab308';
const ATTENTION_RED = '#ef4444';

const STATUS_LABELS = new Map<string, string>([
  ['working', '工作中'], ['monitoring', '监控后台任务'], ['waiting', '等待输入'], ['permission', '需要注意'],
  ['blocked', '已阻塞'], ['failed', '失败'], ['interrupted', '已中断'], ['unconfirmed', '无法确认'],
  ['unverifiable', '暂无更新'], ['done', '已完成'], ['idle', '空闲']
]);

interface VisibleAgent { key: string; row: AgentListRow; preview: string; }

@Component
export struct AgentListRows {
  @Prop rows: AgentListRow[] = [];
  @Prop idleRows: AgentListRow[] = [];
  @Prop desktops: AgentDesktop[] = [];
  @Prop nameDesktop: boolean = false;
  @Prop footer: string = 'workspace';
  @Prop idleKey: string = 'status';
  @Prop expanded: string[] = [];
  @Prop now: number = 0;
  @StorageProp('uiLocale') locale: string = 'en';
  @StorageProp('themeScheme') scheme: string = 'dark';
  @StorageProp('themeText') text: string = '#fafafa';
  @StorageProp('themeSecondary') secondary: string = '#acacac';
  @StorageProp('themeMuted') muted: string = '#898989';
  @StorageProp('themeBorder') borderTint: string = '#2c2c2c';
  @StorageProp('themeSurface') surface: string = '#171717';
  @StorageProp('themeAccent') accent: string = '#3276f2';
  onToggle: (key: string) => void = () => {};
  onOpen: (row: AgentListRow) => void = () => {};
  onActions: (row: AgentListRow) => void = () => {};
  onRead: (rows: AgentListRow[], read: boolean) => void = () => {};
  onClear: (rows: AgentListRow[]) => void = () => {};
  private listScroller: ListScroller = new ListScroller();
  private swipedRows: Set<string> = new Set();

  private visibleRows(rows: AgentListRow[]): VisibleAgent[] {
    let result: VisibleAgent[] = [];
    rows.forEach((row: AgentListRow): void => {
      result.push({ key: row.key, row: row, preview: agentPreview(row) });
      if (this.expanded.includes(row.key)) {
        row.workers.forEach((worker: AgentListRow): void => {
          result.push({ key: `${row.key}>${worker.key}`, row: worker, preview: agentPreview(worker) });
        });
      }
    });
    return result;
  }

  private renderKey(item: VisibleAgent, prefix: string, inset: boolean): string {
    // ForEach keeps the old row's builder parameters until its key changes.
    return JSON.stringify([prefix, item.key, inset, agentRowRevision(item.row, item.preview)]);
  }

  private place(row: AgentListRow): string {
    let label = this.footer === 'agent' ? agentKind(row) : row.entry.workspaceName;
    let desktop = this.desktops.find((host: AgentDesktop): boolean => host.id === row.hostId);
    return [label, this.nameDesktop ? desktop?.name ?? '' : ''].filter((part: string): boolean => part.length > 0).join(' · ');
  }

  private color(state: string): string {
    if (['permission', 'waiting', 'blocked', 'failed'].includes(state)) { return ATTENTION_RED; }
    if (state === 'done') { return '#10b981'; }
    if (state === 'interrupted') { return this.muted; }
    return 'rgba(115,115,115,0.4)';
  }

  private stateLabel(row: AgentListRow): string {
    return uiText(STATUS_LABELS.get(row.dotState) ?? '', this.locale);
  }

  private workersLabel(row: AgentListRow): string {
    return uiText(row.workers.length === 1 ? '{{count}} 个子智能体（单数）' : '{{count}} 个子智能体', this.locale)
      .replace('{{count}}', String(row.workers.length));
  }

  private timeLabel(row: AgentListRow): string {
    return agentTimeAgo(row.timeAt, this.now || Date.now(), this.locale);
  }

  private rowLabel(row: AgentListRow, preview: string): string {
    return [row.title, row.unread ? uiText('未读', this.locale) : '', row.stale ? '' : this.stateLabel(row),
      preview, this.place(row), this.timeLabel(row), row.workers.length > 0 ? this.workersLabel(row) : '']
      .filter((part: string): boolean => part.length > 0).join(', ');
  }

  private closeSwipedRow(key: string): boolean {
    if (!this.swipedRows.has(key)) { return false; }
    this.listScroller.closeAllSwipeActions();
    return true;
  }

  private accessibilityActions(row: AgentListRow, key: string): AccessibilityCustomAction[] {
    let actions: AccessibilityCustomAction[] = [
      { name: uiText('智能体列表选项', this.locale), onAction: (): void => this.onActions(row) }
    ];
    if (row.workers.length > 0) {
      actions.push({ name: uiText(this.expanded.includes(row.key) ? '收起' : '显示子智能体', this.locale),
        onAction: (): void => { if (!this.closeSwipedRow(key)) { this.onToggle(row.key); } } });
    }
    if (row.unread !== undefined && !row.offline) {
      actions.push({ name: uiText(row.unread ? '标为已读' : '标为未读', this.locale),
        onAction: (): void => this.onRead([row], row.unread === true) });
    }
    if (row.clearable && !row.offline) {
      actions.push({ name: uiText('清除列表项', this.locale), onAction: (): void => this.onClear([row]) });
    }
    return actions;
  }

  @Builder
  private statusGlyph(row: AgentListRow) {
    Stack({ alignContent: Alignment.Start }) {
      if (row.dotState === 'working') {
        LoadingProgress().width(12).height(12).color(ACTIVITY_AMBER)
      } else if (row.dotState === 'monitoring') {
        Image($r('app.media.lucide_activity')).width(12).height(12).supportSvg2(true)
          .colorFilter(lucideColorFilter(ACTIVITY_AMBER))
      } else if (row.dotState === 'unconfirmed') {
        Blank().width(8).height(8).border({ width: 1.5, radius: 4, style: BorderStyle.Dashed, color: ACTIVITY_AMBER })
      } else {
        Circle({ width: 8, height: 8 }).fill(this.color(row.dotState))
      }
    }.width(24).height(20).opacity(row.stale ? 0.45 : 1)
  }

  @Builder
  private agentMark(agentType: string) {
    if (agentType === 'codex') {
      Image($r('app.media.agent_codex')).width(13).height(13).supportSvg2(true)
        .colorFilter(lucideColorFilter(this.text))
    } else if (agentType === 'claude' || agentType === 'claude-agent-teams') {
      Image($r('app.media.agent_claude')).width(13).height(13).supportSvg2(true)
    } else if (agentType) {
      Image($r('app.media.lucide_bot')).width(13).height(13).supportSvg2(true)
        .colorFilter(lucideColorFilter(this.muted))
    }
  }

  @Builder
  private workerToggle(row: AgentListRow, key: string) {
    Row({ space: 4 }) {
      Image(this.expanded.includes(row.key) ? $r('app.media.lucide_chevron_down') : $r('app.media.lucide_chevron_right'))
        .width(13).height(13).supportSvg2(true).colorFilter(lucideColorFilter(this.secondary))
      Text(this.workersLabel(row)).fontFamily('Geist').fontSize(12).fontWeight(FontWeight.Medium)
        .fontColor(this.secondary).maxLines(1)
    }.responseRegion({ x: -8, y: -6, width: 'calc(100% + 16vp)', height: 'calc(100% + 12vp)' })
      .gesture(TapGesture().onAction((): void => {
        if (!this.closeSwipedRow(key)) { this.onToggle(row.key); }
      }))
  }

  @Builder
  private agentRow(row: AgentListRow, key: string, preview: string) {
    Row() {
      this.statusGlyph(row)
      Column({ space: 3 }) {
        Row({ space: 8 }) {
          Text(row.title).fontFamily('Geist').fontSize(15)
            .fontWeight(row.unread ? FontWeight.Medium : FontWeight.Normal).fontColor(this.text)
            .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis }).layoutWeight(1)
          if (row.timeAt > 0) {
            Text(this.timeLabel(row)).fontFamily('Geist').fontSize(12).fontColor(this.muted).maxLines(1)
          }
        }.width('100%').alignItems(VerticalAlign.Center)
        if (preview || agentNeedsAttention(row)) {
          Text() {
            if (agentNeedsAttention(row)) {
              Span(this.stateLabel(row)).fontWeight(FontWeight.Medium).fontColor(ATTENTION_RED)
              if (preview) { Span(' · ') }
            }
            Span(preview)
          }.fontFamily('Geist').fontSize(14).lineHeight(19)
            .fontColor(this.secondary).maxLines(2).textOverflow({ overflow: TextOverflow.Ellipsis }).width('100%')
        }
        Row({ space: 6 }) {
          this.agentMark(String(row.entry.agent['agentType'] ?? ''))
          Text(this.place(row)).fontFamily('Geist').fontSize(12).fontColor(this.muted)
            .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis }).layoutWeight(1)
          if (row.unread) {
            Image($r('app.media.lucide_bell')).width(12).height(12).supportSvg2(true)
              .colorFilter(lucideColorFilter(this.scheme === 'light' ? '#ca8a04' : ACTIVITY_AMBER))
          }
          if (row.workers.length > 0) { this.workerToggle(row, key) }
        }.width('100%')
      }.alignItems(HorizontalAlign.Start).layoutWeight(1).opacity(row.stale ? 0.45 : 1)
    }.alignItems(VerticalAlign.Top).width('100%').backgroundColor(this.surface)
      .padding({ left: ROW_TEXT_INSET - 24 + row.depth * WORKER_INDENT, right: 14, top: 9, bottom: 10 })
      .accessibilityGroup(true).accessibilityRole(AccessibilityRoleType.BUTTON)
      .accessibilityText(this.rowLabel(row, preview))
      .accessibilityCustomActions(this.accessibilityActions(row, key))
      .onClick((): void => { if (!this.closeSwipedRow(key)) { this.onOpen(row); } })
      .gesture(LongPressGesture({ duration: 400 }).onAction((): void => {
        if (!this.closeSwipedRow(key)) { this.onActions(row); }
      }))
  }

  @Builder
  private swipeButton(row: AgentListRow, clear: boolean) {
    Button({ type: ButtonType.Normal }) {
      Column({ space: 2 }) {
        Image(clear ? $r('app.media.lucide_x') : row.unread ? $r('app.media.lucide_eye') : $r('app.media.lucide_eye_off'))
          .width(17).height(17).supportSvg2(true).colorFilter(lucideColorFilter('#ffffff'))
        Text(uiText(clear ? '清除' : row.unread ? '已读' : '未读', this.locale))
          .fontFamily('Geist').fontSize(11).fontWeight(FontWeight.Medium).fontColor(Color.White)
      }
    }.borderRadius(0).width(84).height('100%').backgroundColor(clear ? this.muted : this.accent)
      .accessibilityText(uiText(clear ? '清除列表项' : row.unread ? '标为已读' : '标为未读', this.locale))
      .onClick(() => {
        this.listScroller.closeAllSwipeActions();
        if (clear) { this.onClear([row]); }
        else { this.onRead([row], row.unread === true); }
      })
  }

  @Builder
  private items(idle: boolean) {
    ForEach(this.visibleRows(idle ? this.idleRows : this.rows), (item: VisibleAgent, index: number) => {
      ListItem() {
        Column() {
          if (index > 0 || idle) { this.separator(ROW_TEXT_INSET + item.row.depth * WORKER_INDENT) }
          this.agentRow(item.row, item.key, item.preview)
        }.width('100%')
      }.swipeAction({
        start: item.row.unread !== undefined && !item.row.offline ? () => this.swipeButton(item.row, false) : undefined,
        end: item.row.clearable && !item.row.offline ? () => this.swipeButton(item.row, true) : undefined,
        edgeEffect: SwipeEdgeEffect.None,
        onOffsetChange: (offset: number): void => {
          if (offset === 0) { this.swipedRows.delete(item.key); }
          else { this.swipedRows.add(item.key); }
        }
      }).onDisAppear((): void => { this.swipedRows.delete(item.key); })
    }, (item: VisibleAgent, index: number): string => this.renderKey(item, idle ? 'idle:' : '', index > 0 || idle))
  }

  @Builder
  private separator(inset: number) {
    Row() {
      Divider().strokeWidth(0.5).color(this.borderTint).layoutWeight(1)
    }.width('100%').padding({ left: inset })
  }

  build() {
    List({ scroller: this.listScroller }) {
      this.items(false)
      if (this.idleRows.length > 0) {
        ListItem() {
          Column() {
            if (this.rows.length > 0) { this.separator(ROW_TEXT_INSET) }
            Row({ space: 8 }) {
              Image(this.expanded.includes(this.idleKey) ? $r('app.media.lucide_chevron_down') : $r('app.media.lucide_chevron_right'))
                .width(15).height(15).supportSvg2(true).colorFilter(lucideColorFilter(this.muted))
              Text(`${uiText('空闲', this.locale)} · ${this.idleRows.length}`).fontFamily('Geist').fontSize(14).fontColor(this.secondary)
            }.width('100%').height(44).padding({ left: ROW_TEXT_INSET - 4 })
              .accessibilityGroup(true).accessibilityRole(AccessibilityRoleType.BUTTON)
              .onClick(() => this.onToggle(this.idleKey))
          }.width('100%')
        }
        if (this.expanded.includes(this.idleKey)) { this.items(true) }
      }
    }.width('100%').height('auto').enableScrollInteraction(false).scrollBar(BarState.Off)
      .borderRadius(16).backgroundColor(this.surface).clip(true)
  }
}
