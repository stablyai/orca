import { getString, setString } from '../settings/SettingsStore';
import { uiText } from '../settings/NativeUi';
import { lucideColorFilter } from '../settings/LucideColor';
import {
  AGENT_GROUPS, AgentDesktop, AgentDesktopSummary, AgentListResult, AgentListRow, AgentListSection, AgentListView,
  DEFAULT_AGENT_VIEW, agentPreview, agentRowRevision, agentTimeAgo, buildAgentList, listedAgents, readAgentView, summarizeAgentDesktops
} from './AgentListModel';
import { AgentListRows } from './AgentListRows';

const AGENT_LIST_VIEW = 'orca:agentListView';

const GROUP_LABELS = new Map<string, string>([
  ['status', '状态'], ['workspace', '工作区'], ['project', '项目'], ['agent', '智能体类型'], ['desktop', '桌面']
]);
const SECTION_LABELS = new Map<string, string>([['needs-you', '需要处理'], ['working', '工作中'], ['done', '已完成']]);

@Component
export struct AgentsTab {
  @Prop @Watch('refreshList') desktops: AgentDesktop[] = [];
  @Prop loaded: boolean = false;
  @Prop now: number = 0;
  @StorageProp('uiLocale') locale: string = 'en';
  @StorageProp('themeText') text: string = '#fafafa';
  @StorageProp('themeSecondary') secondary: string = '#acacac';
  @StorageProp('themeMuted') muted: string = '#898989';
  @StorageProp('themeSurface') surface: string = '#171717';
  @StorageProp('themeRaised') raised: string = '#262626';
  @StorageProp('themeSheet') sheet: string = '#171717';
  @StorageProp('themeAccent') accent: string = '#3276f2';
  @StorageProp('themeBorder') borderTint: string = '#2c2c2c';
  @State view: AgentListView = DEFAULT_AGENT_VIEW;
  @State list: AgentListResult = { sections: [], anyLive: false };
  @State shownRows: AgentListRow[] = [];
  @State expanded: string[] = [];
  @State searchOpen: boolean = false;
  @State query: string = '';
  @State desktopId: string = '';
  @State choosingDesktop: boolean = false;
  @State summaries: AgentDesktopSummary[] = [];
  private viewRevision: number = 0;
  private save: Promise<void> = Promise.resolve();
  onOpen: (row: AgentListRow) => void = () => {};
  onActions: (row: AgentListRow) => void = () => {};
  onRead: (rows: AgentListRow[], read: boolean) => void = () => {};
  onClear: (rows: AgentListRow[]) => void = () => {};

  aboutToAppear(): void {
    this.refreshList();
    let revision = this.viewRevision;
    getString(getContext(this), AGENT_LIST_VIEW).then((raw: string): void => {
      if (revision !== this.viewRevision) { return; }
      this.view = readAgentView(raw);
      this.refreshList();
    }).catch(() => {});
  }

  private tr(key: string): string { return uiText(key, this.locale); }

  refreshList(): void {
    if (this.desktopId && !this.desktops.some((desktop: AgentDesktop): boolean => desktop.id === this.desktopId)) {
      this.desktopId = '';
    }
    this.list = buildAgentList(this.desktops, this.view, this.desktopId, this.query);
    this.shownRows = listedAgents(this.list.sections);
    this.summaries = summarizeAgentDesktops(this.desktops);
  }

  private setView(group: string, workers: boolean, unread: boolean): void {
    this.viewRevision++;
    this.view = { groupBy: group, showWorkers: workers, unreadOnly: unread };
    this.refreshList();
    let value = JSON.stringify(this.view);
    let context = getContext(this);
    this.save = this.save.then(() => setString(context, AGENT_LIST_VIEW, value)).catch(() => {});
  }

  private groupTitle(group: string): string {
    return this.tr(GROUP_LABELS.get(group) ?? '状态');
  }

  private unreadRows(): AgentListRow[] { return this.shownRows.filter((row: AgentListRow): boolean => row.unread === true); }
  private clearableRows(rows: AgentListRow[]): AgentListRow[] {
    return rows.filter((row: AgentListRow): boolean => row.clearable);
  }

  private toggle(key: string): void {
    this.expanded = this.expanded.includes(key) ? this.expanded.filter((value: string): boolean => value !== key) : this.expanded.concat([key]);
  }

  private desktopName(id: string): string {
    return this.desktops.find((host: AgentDesktop): boolean => host.id === id)?.name ?? this.tr('所有桌面');
  }

  private sectionTitle(section: AgentListSection): string {
    if (section.kind === 'desktop') { return this.desktopName(section.hostId ?? ''); }
    return section.title ?? this.tr(SECTION_LABELS.get(section.kind) ?? '');
  }

  private sectionAside(section: AgentListSection): string {
    if (section.lastSeen) {
      let when = section.lastSeen.at;
      let now = this.now || Date.now();
      let ago = when !== undefined && now - when < 60000 ? this.tr('刚刚在线')
        : when !== undefined ? this.tr('上次在线 {{time}}').replace('{{time}}', agentTimeAgo(when, now, this.locale)) : '';
      return [section.lastSeen.offline ? this.tr('离线') : '', ago].filter((part: string): boolean => !!part).join(' · ');
    }
    if (!this.desktopId && this.desktops.length > 1 && ['workspace', 'project'].includes(section.kind)) {
      return this.desktopName(section.hostId ?? '');
    }
    return '';
  }

  private sectionKey(section: AgentListSection): string {
    let rows = listedAgents([section]);
    return JSON.stringify([section.kind, section.key, section.title, section.lastSeen, section.nameDesktop,
      section.rows.length, rows.map((row: AgentListRow): string => agentRowRevision(row, agentPreview(row)))]);
  }

  @Builder
  private groupMenu() {
    Menu() {
      ForEach(AGENT_GROUPS, (group: string) => {
        MenuItem({ content: this.groupTitle(group) }).selected(this.view.groupBy === group).selectIcon(true)
          .onClick(() => this.setView(group, this.view.showWorkers, this.view.unreadOnly))
      }, (group: string): string => group)
    }
  }

  @Builder
  private optionsMenu() {
    Menu() {
      MenuItem({ content: this.tr('分组方式'), labelInfo: this.groupTitle(this.view.groupBy), builder: () => this.groupMenu() })
      MenuItem({ content: this.tr('仅未读') }).selected(this.view.unreadOnly).selectIcon(true)
        .onClick(() => this.setView(this.view.groupBy, this.view.showWorkers, !this.view.unreadOnly))
      MenuItem({ content: this.tr('显示子智能体') }).selected(this.view.showWorkers).selectIcon(true)
        .onClick(() => this.setView(this.view.groupBy, !this.view.showWorkers, this.view.unreadOnly))
      MenuItem({ content: this.tr('全部标为已读') }).enabled(this.unreadRows().length > 0)
        .onClick(() => this.onRead(this.unreadRows(), true))
      MenuItem({ content: this.tr('清除已完成') }).enabled(this.clearableRows(this.shownRows).length > 0)
        .onClick(() => this.onClear(this.clearableRows(this.shownRows)))
    }
  }

  private desktopSubtitle(id: string): string {
    let summary = this.summaries.find((item: AgentDesktopSummary): boolean => item.hostId === id);
    if (summary?.offline) { return this.tr('离线'); }
    let count = summary?.agents ?? this.summaries.reduce((sum: number, item: AgentDesktopSummary): number => sum + item.agents, 0);
    let label = this.tr(count === 1 ? '{{count}} 个智能体（单数）' : '{{count}} 个智能体').replace('{{count}}', String(count));
    if (!summary?.needsYou) { return label; }
    let needed = this.tr(summary.needsYou === 1 ? '{{count}} 个需要处理（单数）' : '{{count}} 个需要处理');
    return `${label} · ${needed.replace('{{count}}', String(summary.needsYou))}`;
  }

  @Builder
  private desktopOption(id: string, title: string) {
    Row({ space: 10 }) {
      Image(this.summaries.some((item: AgentDesktopSummary): boolean => item.hostId === id && item.offline)
        ? $r('app.media.lucide_wifi_off') : $r('app.media.lucide_monitor'))
        .width(18).height(18).supportSvg2(true).colorFilter(lucideColorFilter(this.secondary))
      Column({ space: 4 }) {
        Text(title).fontFamily('Geist').fontSize(16).fontColor(this.text)
        Text(this.desktopSubtitle(id)).fontFamily('Geist').fontSize(13).fontColor(this.muted)
      }.layoutWeight(1).alignItems(HorizontalAlign.Start)
      if (this.desktopId === id) {
        Image($r('app.media.lucide_check')).width(18).height(18).supportSvg2(true).colorFilter(lucideColorFilter(this.text))
      }
    }.width('100%').padding({ left: 14, right: 14, top: 11, bottom: 11 })
      .accessibilityGroup(true).accessibilityRole(AccessibilityRoleType.BUTTON).accessibilitySelected(this.desktopId === id)
      .onClick(() => {
      this.desktopId = id;
      this.choosingDesktop = false;
      this.refreshList();
    })
  }

  @Builder
  private desktopPicker() {
    Column({ space: 12 }) {
      Text(this.tr('选择显示智能体的桌面')).fontFamily('Geist').fontSize(17).fontWeight(FontWeight.Medium)
        .fontColor(this.text).width('100%').padding({ left: 4, right: 4 })
      Scroll() {
        Column() {
          this.desktopOption('', this.tr('所有桌面'))
          ForEach(this.desktops, (host: AgentDesktop) => {
            Divider().strokeWidth(0.5).color(this.borderTint).margin({ left: 42 })
            this.desktopOption(host.id, host.name)
          }, (host: AgentDesktop): string => `${host.id}:${host.name}:${this.desktopSubtitle(host.id)}`)
        }.width('100%').backgroundColor(this.surface).borderRadius(16).clip(true)
      }.width('100%').constraintSize({ maxHeight: 380 }).scrollBar(BarState.Off)
    }.width('100%').padding({ left: 16, right: 16, top: 14, bottom: 20 })
  }

  private isConnecting(): boolean {
    return this.desktops.some((host: AgentDesktop): boolean => (!this.desktopId || host.id === this.desktopId) &&
      host.loading);
  }

  @Builder
  private empty(title: string, description: string) {
    Column({ space: 10 }) {
      Image($r('app.media.lucide_bot')).width(30).height(30).supportSvg2(true).colorFilter(lucideColorFilter(this.muted))
      Text(title).fontFamily('Geist').fontSize(17).fontWeight(FontWeight.Medium).fontColor(this.text).textAlign(TextAlign.Center)
      if (description) {
        Text(description).fontFamily('Geist').fontSize(14).fontColor(this.secondary).textAlign(TextAlign.Center)
      }
    }.width('100%').padding(24).margin({ top: 32 })
  }

  @Builder
  private section(section: AgentListSection) {
    Column({ space: 8 }) {
      if (this.sectionTitle(section)) {
        Row({ space: 6 }) {
          Text(this.sectionTitle(section)).fontFamily('Geist').fontSize(15)
            .fontWeight(FontWeight.Medium).fontColor(this.text).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
          if (!['workspace', 'project'].includes(section.kind) && section.rows.length > 0) {
            Text(String(section.rows.length)).fontFamily('Geist').fontSize(13).fontColor(this.muted)
          }
          Blank()
          if (section.kind === 'done' && this.clearableRows(listedAgents([section])).length > 0) {
            Text(this.tr('清除')).fontColor(this.accent).fontSize(13).padding({ top: 6, bottom: 6 })
              .onClick(() => this.onClear(this.clearableRows(listedAgents([section]))))
          } else if (this.sectionAside(section)) {
            Row({ space: 4 }) {
              if (section.lastSeen?.offline) {
                Image($r('app.media.lucide_wifi_off')).width(13).height(13).supportSvg2(true).colorFilter(lucideColorFilter(this.muted))
              }
              Text(this.sectionAside(section)).fontFamily('Geist').fontSize(13).fontColor(this.muted).maxLines(1)
            }
          }
        }.width('100%').padding({ left: 4, right: 4 })
      }
      if (section.rows.length > 0 || (section.idleRows?.length ?? 0) > 0) {
        AgentListRows({ rows: section.rows, idleRows: section.idleRows ?? [], desktops: this.desktops,
          nameDesktop: section.nameDesktop, footer: section.footer, idleKey: `idle:${this.view.groupBy}`,
          expanded: this.expanded, now: this.now, onToggle: (key: string): void => this.toggle(key),
          onOpen: this.onOpen, onActions: this.onActions, onRead: this.onRead, onClear: this.onClear })
      }
    }.width('100%').alignItems(HorizontalAlign.Start)
  }

  build() {
    Column({ space: 8 }) {
      Row({ space: 2 }) {
        Text(this.tr('智能体')).fontFamily('Geist').fontSize(22).fontWeight(FontWeight.Bold).fontColor(this.text).layoutWeight(1)
        Button() {
          Image($r('app.media.lucide_search')).width(21).height(21).supportSvg2(true).colorFilter(lucideColorFilter(this.secondary))
        }.width(44).height(44).borderRadius(12).backgroundColor(this.searchOpen ? this.raised : Color.Transparent)
          .accessibilityText(this.tr('搜索智能体')).onClick(() => {
            this.searchOpen = !this.searchOpen; this.query = ''; this.refreshList();
          })
        Button() {
          Image($r('app.media.lucide_sliders_horizontal')).width(21).height(21).supportSvg2(true).colorFilter(lucideColorFilter(this.secondary))
        }.width(44).height(44).borderRadius(12).backgroundColor(Color.Transparent).accessibilityText(this.tr('智能体列表选项'))
          .bindMenu(this.optionsMenu)
      }.width('100%').height(44).padding({ left: 20, right: 8 })
      if (this.searchOpen) {
        Search({ value: this.query, placeholder: this.tr('搜索智能体') })
          .id('agent-search-field').height(42).width('calc(100% - 32vp)').backgroundColor(this.surface)
          .onAppear((): void => {
            setTimeout((): void => { if (this.searchOpen) { this.getUIContext().getFocusController().requestFocus('agent-search-field'); } }, 0);
          })
          .fontColor(this.text).onChange((query: string) => { this.query = query; this.refreshList(); })
      }
      if (this.desktops.length > 1) {
        Row() {
          Button() {
            Row({ space: 7 }) {
              Image($r('app.media.lucide_monitor')).width(15).height(15).supportSvg2(true).colorFilter(lucideColorFilter(this.text))
              Text(this.desktopName(this.desktopId)).fontFamily('Geist').fontSize(14).fontColor(this.text).maxLines(1)
              Image($r('app.media.lucide_chevron_down')).width(14).height(14).supportSvg2(true).colorFilter(lucideColorFilter(this.secondary))
            }
          }.height(36).backgroundColor(this.surface).onClick(() => { this.choosingDesktop = true; })
            .bindSheet(this.choosingDesktop, this.desktopPicker, { height: SheetSize.FIT_CONTENT,
              backgroundColor: this.sheet, maskColor: 'rgba(0,0,0,0.55)', showClose: false,
              onDisappear: (): void => { this.choosingDesktop = false; } })
        }.width('100%').padding({ left: 16 })
      }
      Scroll() {
        Column({ space: 16 }) {
          if (this.loaded) {
            if (this.list.sections.length > 0) {
              ForEach(this.list.sections, (section: AgentListSection) => { this.section(section) },
                (section: AgentListSection): string => this.sectionKey(section))
            } else if (this.query.trim()) {
              this.empty(this.tr('没有与“{{query}}”匹配的智能体').replace('{{query}}', this.query.trim()), '')
            } else if (!this.desktops.length) {
              this.empty(this.tr('没有运行中的智能体'), this.tr('配对桌面后可在这里查看智能体。'))
            } else if (!this.list.anyLive && this.isConnecting()) {
              LoadingProgress().width(28).height(28).color(this.secondary).margin({ top: 42 })
            } else if (!this.list.anyLive) {
              this.empty(this.tr('没有连接的桌面'), this.tr('连接桌面后，智能体会显示在这里。'))
            } else {
              this.empty(this.tr('没有运行中的智能体'), this.tr('在任意工作区启动智能体后，就会显示在这里。'))
            }
          }
        }.width('100%').constraintSize({ maxWidth: 720 }).padding({ left: 16, right: 16, bottom: 24 })
      }.width('100%').layoutWeight(1).scrollBar(BarState.Off).align(Alignment.Top)
    }.width('100%').height('100%')
  }
}
