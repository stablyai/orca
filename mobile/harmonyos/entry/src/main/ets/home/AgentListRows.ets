import { uiText } from '../settings/NativeUi';
import { lucideColorFilter } from '../settings/LucideColor';
import { AgentDesktop, AgentListRow, agentKind, agentPreview } from './AgentListModel';

const STATUS_LABELS = new Map<string, string>([
  ['working', '工作中'], ['monitoring', '监控后台任务'], ['waiting', '等待输入'], ['permission', '需要注意'],
  ['blocked', '已阻塞'], ['failed', '失败'], ['interrupted', '已中断'], ['unconfirmed', '无法确认'],
  ['unverifiable', '暂无更新'], ['done', '已完成'], ['idle', '空闲']
]);

interface VisibleAgent { key: string; row: AgentListRow; }

@Component
export struct AgentListRows {
  @Prop rows: AgentListRow[] = [];
  @Prop idleRows: AgentListRow[] = [];
  @Prop desktops: AgentDesktop[] = [];
  @Prop nameDesktop: boolean = false;
  @Prop footer: string = 'workspace';
  @Prop idleKey: string = 'status';
  @Prop expanded: string[] = [];
  @Prop fontScale: number = 1;
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

  private visibleRows(rows: AgentListRow[]): VisibleAgent[] {
    let result: VisibleAgent[] = [];
    rows.forEach((row: AgentListRow): void => {
      result.push({ key: row.key, row: row });
      if (this.expanded.includes(row.key)) {
        row.workers.forEach((worker: AgentListRow): void => {
          result.push({ key: `${row.key}>${worker.key}`, row: worker });
        });
      }
    });
    return result;
  }

  private place(row: AgentListRow): string {
    let label = this.footer === 'agent' ? agentKind(row) : row.entry.workspaceName;
    let desktop = this.desktops.find((host: AgentDesktop): boolean => host.id === row.hostId);
    return this.nameDesktop && desktop ? `${label} · ${desktop.name}` : label;
  }

  private color(state: string): string {
    if (['permission', 'waiting', 'blocked'].includes(state)) { return this.scheme === 'light' ? '#ca8a04' : '#eab308'; }
    if (state === 'failed') { return this.scheme === 'light' ? '#b91c1c' : '#ff6568'; }
    if (state === 'done') { return this.scheme === 'light' ? '#147638' : '#86efac'; }
    if (['working', 'monitoring'].includes(state)) { return this.accent; }
    return this.muted;
  }

  private stateLabel(state: string): string {
    return uiText(STATUS_LABELS.get(state) ?? '', this.locale);
  }

  @Builder
  private agentRow(row: AgentListRow) {
    Row({ space: 10 }) {
      Stack({ alignContent: Alignment.TopEnd }) {
        Circle({ width: 9, height: 9 }).fill(this.color(row.dotState)).align(Alignment.Center)
        if (row.unread === true) {
          Circle({ width: 5, height: 5 }).fill(this.accent)
        }
      }.width(18).height(18).margin({ top: 3 })
      Column({ space: 3 }) {
        Text(row.title).fontFamily('Geist').fontSize(16 * this.fontScale).fontWeight(FontWeight.Medium)
          .fontColor(this.text).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis }).width('100%')
        if (agentPreview(row)) {
          Text(agentPreview(row)).fontFamily('Geist').fontSize(14).fontColor(this.secondary)
            .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis }).width('100%')
        }
        Text(row.stale ? this.place(row) : `${this.stateLabel(row.dotState)} · ${this.place(row)}`)
          .fontFamily('Geist').fontSize(12).fontColor(this.muted).maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis }).width('100%')
      }.alignItems(HorizontalAlign.Start).layoutWeight(1)
      if (row.workers.length > 0) {
        Button() {
          Row({ space: 4 }) {
            Text(String(row.workers.length)).fontSize(13).fontColor(this.secondary)
            Image(this.expanded.includes(row.key) ? $r('app.media.lucide_chevron_down') : $r('app.media.lucide_chevron_right'))
              .width(14).height(14).supportSvg2(true).colorFilter(lucideColorFilter(this.muted))
          }
        }.backgroundColor(Color.Transparent).height(44).padding({ left: 8, right: 8 })
          .accessibilityText(uiText('子智能体', this.locale))
          .onClick(() => this.onToggle(row.key))
      }
    }.alignItems(VerticalAlign.Top).width('100%').padding({ left: 14 + row.depth * 22, right: 12, top: 10, bottom: 10 })
      .opacity(row.offline ? 0.6 : 1)
      .onClick(() => this.onOpen(row))
      .gesture(LongPressGesture().onAction(() => this.onActions(row)))
  }

  @Builder
  private swipeButton(row: AgentListRow, clear: boolean) {
    Button(uiText(clear ? '清除' : row.unread ? '已读' : '未读', this.locale))
      .borderRadius(0).width(84).height('100%').fontFamily('Geist').fontSize(13)
      .backgroundColor(clear ? this.muted : this.accent).fontColor(Color.White)
      .onClick(() => {
        this.listScroller.closeAllSwipeActions();
        if (clear) { this.onClear([row]); }
        else { this.onRead([row], row.unread === true); }
      })
  }

  @Builder
  private items(rows: AgentListRow[], prefix: string) {
    ForEach(this.visibleRows(rows), (item: VisibleAgent) => {
      ListItem() {
        this.agentRow(item.row)
      }.swipeAction({
        start: item.row.unread !== undefined && !item.row.offline ? () => this.swipeButton(item.row, false) : undefined,
        end: item.row.clearable && !item.row.offline ? () => this.swipeButton(item.row, true) : undefined,
        edgeEffect: SwipeEdgeEffect.None
      })
    }, (item: VisibleAgent): string => `${prefix}${item.key}`)
  }

  build() {
    List({ scroller: this.listScroller }) {
      this.items(this.rows, '')
      if (this.idleRows.length > 0) {
        ListItem() {
          Row({ space: 8 }) {
            Image(this.expanded.includes(this.idleKey) ? $r('app.media.lucide_chevron_down') : $r('app.media.lucide_chevron_right'))
              .width(15).height(15).supportSvg2(true).colorFilter(lucideColorFilter(this.muted))
            Text(`${uiText('空闲', this.locale)} · ${this.idleRows.length}`).fontFamily('Geist').fontSize(14).fontColor(this.secondary)
          }.width('100%').height(44).padding({ left: 16 }).onClick(() => this.onToggle(this.idleKey))
        }
        if (this.expanded.includes(this.idleKey)) { this.items(this.idleRows, 'idle:') }
      }
    }.width('100%').height('auto').enableScrollInteraction(false).scrollBar(BarState.Off)
      .divider({ strokeWidth: 0.5, color: this.borderTint, startMargin: 42, endMargin: 0 })
      .borderRadius(16).backgroundColor(this.surface).clip(true)
  }
}
