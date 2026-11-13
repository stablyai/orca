import { util } from '@kit.ArkTS';
import { CustomShortcutSheet } from './CustomShortcutSheet';
import { lucideColorFilter } from './LucideColor';
import { uiText } from './NativeUi';
import { readPagePreferencesSync, writePagePreferenceSync } from './SettingsStore';
import terminalShortcuts, { TerminalAccessoryLayout, TerminalShortcutDescription } from '../vendor/terminal-shortcuts.js';

interface CustomShortcut { id: string; label: string; bytes: string; enter: boolean; visible: boolean; }

const LAYOUT_KEY = 'orca:terminal-accessory-layout';
const CUSTOM_KEYS = 'orca:custom-accessory-keys';
const ROW_HEIGHT = 56;
const DRAG_SCROLL_EDGE = 72;
const DRAG_SCROLL_STEP = 18;
const DRAG_SCROLL_INTERVAL = 32;

@Component
export struct TerminalShortcutSettings {
  @StorageProp('uiLocale') uiLocale: string = 'en';
  @StorageProp('themeSurface') themeSurface: string = '#171717';
  @StorageProp('themeSheet') themeSheet: string = '#171717';
  @StorageProp('themeRaised') themeRaised: string = '#262626';
  @StorageProp('themeBorder') themeBorder: string = 'rgba(255, 255, 255, 0.07)';
  @StorageProp('themeText') themeText: string = '#fafafa';
  @StorageProp('themeMuted') themeMuted: string = '#898989';
  @StorageProp('themeSecondary') themeSecondary: string = '#acacac';
  @StorageProp('themeAccent') themeAccent: string = '#3276f2';
  @StorageProp('themeStatusRed') themeStatusRed: string = '#ff6568';
  @Prop @Watch('reload') directionPadAvailable: boolean = false;
  @Prop @Watch('reload') settingsRevision: number = 0;
  @Prop viewportTop: number = 0;
  @Prop viewportBottom: number = 0;
  @Link scrollingEnabled: boolean;
  scroller: Scroller = new Scroller();
  @State layout: TerminalAccessoryLayout = terminalShortcuts.terminalAccessoryLayout(null, false);
  @State custom: CustomShortcut[] = [];
  @State customOpen: boolean = false;
  @State error: string = '';
  @State dragSection: string = '';
  @State dragFrom: number = -1;
  @State dragTo: number = -1;
  @State dragOffset: number = 0;
  private dragScrollStart: number = 0;
  private dragPointerY: number = 0;
  private dragPanOffset: number = 0;
  private dragScrollTimer: number = -1;

  aboutToAppear(): void { this.reload(); }
  aboutToDisappear(): void { this.cancelDrag(); }

  private t(key: string): string {
    return uiText('components.terminalShortcutSettings.' + key, this.uiLocale);
  }

  private reload(): void {
    this.cancelDrag();
    try {
      const stored = readPagePreferencesSync(getContext(this));
      this.layout = terminalShortcuts.terminalAccessoryLayout(
        JSON.parse(stored.get(LAYOUT_KEY) ?? 'null'), this.directionPadAvailable);
      const keys: ESObject = JSON.parse(stored.get(CUSTOM_KEYS) ?? '[]');
      this.custom = Array.isArray(keys) ? keys.filter((key: ESObject): boolean => key && typeof key.id === 'string'
        && typeof key.label === 'string' && typeof key.bytes === 'string' && typeof key.enter === 'boolean'
        && (key.visible === undefined || typeof key.visible === 'boolean'))
        .map((key: ESObject): CustomShortcut => ({
          id: key.id, label: key.label, bytes: key.bytes, enter: key.enter, visible: key.visible !== false
        })) : [];
      this.error = '';
    } catch (e) {
      this.error = this.t('loadFailed');
    }
  }

  private saveLayout(next: TerminalAccessoryLayout): void {
    try {
      writePagePreferenceSync(getContext(this), LAYOUT_KEY, JSON.stringify(next));
      this.layout = next;
      this.error = '';
    } catch (e) {
      this.error = this.t('saveFailed');
    }
  }

  private resetLayout(): void {
    const next = terminalShortcuts.terminalAccessoryLayout(null, this.directionPadAvailable);
    next.smartRail = this.layout.smartRail;
    this.saveLayout(next);
  }

  private toggleBuiltIn(id: string, enabled: boolean): void {
    const visible = new Set(this.layout.visibleBuiltInIds);
    if (enabled) { visible.add(id); } else { visible.delete(id); }
    const next = this.layoutSnapshot();
    next.visibleBuiltInIds = next.orderedBuiltInIds.filter((key: string): boolean => visible.has(key));
    this.saveLayout(next);
  }

  private layoutSnapshot(): TerminalAccessoryLayout {
    return { version: this.layout.version, orderedBuiltInIds: this.layout.orderedBuiltInIds,
      visibleBuiltInIds: this.layout.visibleBuiltInIds, directionPadEnabled: this.layout.directionPadEnabled,
      smartRail: this.layout.smartRail };
  }

  private saveCustom(keys: CustomShortcut[]): boolean {
    try {
      writePagePreferenceSync(getContext(this), CUSTOM_KEYS, JSON.stringify(keys));
      this.custom = keys;
      this.error = '';
      return true;
    } catch (e) {
      this.error = this.t('saveFailed');
      return false;
    }
  }

  private addCustom(label: string, bytes: string): boolean {
    const key: CustomShortcut = { id: 'custom-' + util.generateRandomUUID(), label: label, bytes: bytes,
      enter: false, visible: true };
    if (!this.saveCustom(this.custom.concat([key]))) { return false; }
    this.customOpen = false;
    return true;
  }

  private toggleCustom(key: CustomShortcut, visible: boolean): void {
    this.saveCustom(this.custom.map((item: CustomShortcut): CustomShortcut =>
      item.id === key.id ? { id: item.id, label: item.label, bytes: item.bytes, enter: item.enter, visible: visible } : item));
  }

  private count(section: string): number {
    return section === 'custom' ? this.custom.length : this.layout.orderedBuiltInIds.length;
  }

  private move(section: string, from: number, to: number): void {
    if (from < 0 || to < 0 || from >= this.count(section) || to >= this.count(section) || from === to) { return; }
    if (section === 'custom') {
      const next = this.custom.slice();
      next.splice(to, 0, next.splice(from, 1)[0]);
      this.saveCustom(next);
    } else {
      const next = this.layout.orderedBuiltInIds.slice();
      next.splice(to, 0, next.splice(from, 1)[0]);
      const layout = this.layoutSnapshot();
      layout.orderedBuiltInIds = next;
      this.saveLayout(layout);
    }
  }

  private reorderActions(section: string, index: number): AccessibilityCustomAction[] {
    const actions: AccessibilityCustomAction[] = [];
    if (index > 0) {
      actions.push({ name: uiText('components.dragReorderRow.moveUp', this.uiLocale),
        onAction: (): void => { this.move(section, index, index - 1); } });
    }
    if (index + 1 < this.count(section)) {
      actions.push({ name: uiText('components.dragReorderRow.moveDown', this.uiLocale),
        onAction: (): void => { this.move(section, index, index + 1); } });
    }
    return actions;
  }

  private beginDrag(section: string, index: number): void {
    this.cancelDrag();
    this.scrollingEnabled = false;
    this.dragSection = section;
    this.dragFrom = index;
    this.dragTo = index;
    this.dragScrollStart = this.scroller.currentOffset().yOffset;
  }

  private trackDrag(event: GestureEvent): void {
    if (!this.dragSection) { return; }
    this.dragPointerY = event.fingerInfos?.[0]?.globalY ?? event.fingerList[0]?.globalY ?? this.dragPointerY;
    this.dragPanOffset = event.offsetY;
    this.updateDrag();
    if (this.dragScrollTimer < 0) {
      this.dragScrollTimer = setInterval((): void => { this.scrollDuringDrag(); }, DRAG_SCROLL_INTERVAL);
    }
  }

  private updateDrag(): void {
    if (!this.dragSection) { return; }
    const limit = this.count(this.dragSection) - 1;
    const offset = this.dragPanOffset + this.scroller.currentOffset().yOffset - this.dragScrollStart;
    this.dragOffset = Math.max(-this.dragFrom * ROW_HEIGHT, Math.min((limit - this.dragFrom) * ROW_HEIGHT, offset));
    this.dragTo = this.dragFrom + Math.round(this.dragOffset / ROW_HEIGHT);
  }

  private scrollDuringDrag(): void {
    const top = this.viewportTop + DRAG_SCROLL_EDGE;
    const bottom = this.viewportBottom - DRAG_SCROLL_EDGE;
    if (bottom <= top || !this.dragSection) { return; }
    if (this.dragPointerY < top && this.dragTo > 0) {
      this.scroller.scrollBy(0, -DRAG_SCROLL_STEP * Math.min(1, (top - this.dragPointerY) / DRAG_SCROLL_EDGE));
    } else if (this.dragPointerY > bottom && this.dragTo + 1 < this.count(this.dragSection)) {
      this.scroller.scrollBy(0, DRAG_SCROLL_STEP * Math.min(1, (this.dragPointerY - bottom) / DRAG_SCROLL_EDGE));
    }
    this.updateDrag();
  }

  private finishDrag(event: GestureEvent): void {
    if (!this.dragSection) { return; }
    this.trackDrag(event);
    const section = this.dragSection;
    const from = this.dragFrom;
    const to = this.dragTo;
    this.cancelDrag();
    this.move(section, from, to);
  }

  private cancelDrag(): void {
    if (this.dragScrollTimer >= 0) { clearInterval(this.dragScrollTimer); this.dragScrollTimer = -1; }
    this.dragSection = '';
    this.dragFrom = -1;
    this.dragTo = -1;
    this.dragOffset = 0;
    this.dragPanOffset = 0;
    this.scrollingEnabled = true;
  }

  private rowOffset(index: number, from: number, to: number, offset: number): number {
    if (index === from) { return offset; }
    if (index > from && index <= to) { return -ROW_HEIGHT; }
    if (index < from && index >= to) { return ROW_HEIGHT; }
    return 0;
  }

  private builtIn(id: string): TerminalShortcutDescription {
    return terminalShortcuts.describeBuiltInShortcut(id, (key: string, fallback: string): string => {
      const translated = uiText(key, this.uiLocale);
      return translated === key ? fallback : translated;
    });
  }

  @Builder
  private grip(section: string, index: number) {
    Button({ type: ButtonType.Normal }) {
      Image($r('app.media.lucide_grip_vertical')).supportSvg2(true).width(18).height(18).draggable(false)
        .colorFilter(lucideColorFilter(this.themeMuted))
    }.width(44).height(44).backgroundColor(Color.Transparent)
      .accessibilityText(uiText('components.dragReorderRow.dragToReorder', this.uiLocale))
      .accessibilityDescription(uiText('components.dragReorderRow.reorderHint', this.uiLocale))
      .accessibilityCustomActions(this.reorderActions(section, index))
      .gesture(GestureGroup(GestureMode.Sequence,
        LongPressGesture({ duration: 200 }).onAction((): void => { this.beginDrag(section, index); }),
        PanGesture({ direction: PanDirection.Vertical, distance: 4 })
          .onActionStart((event: GestureEvent): void => { this.trackDrag(event); })
          .onActionUpdate((event: GestureEvent): void => { this.trackDrag(event); })
          .onActionEnd((event: GestureEvent): void => { this.finishDrag(event); })
          .onActionCancel((): void => { this.cancelDrag(); })
      ).onCancel((): void => { this.cancelDrag(); }))
  }

  @Builder
  private keycap(label: string) {
    Text(label).fontFamily('monospace').fontSize(12).fontColor(this.themeSecondary)
      .textAlign(TextAlign.Center).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
      .width(62).padding({ left: 4, right: 4, top: 4, bottom: 4 })
      .borderRadius(8).backgroundColor(this.themeRaised)
  }

  @Builder
  private builtInRow(id: string, index: number) {
    Row({ space: 12 }) {
      this.keycap(this.builtIn(id).label)
      Text(this.builtIn(id).title).fontFamily('Geist').fontSize(15).fontColor(this.themeText).layoutWeight(1)
      Toggle({ type: ToggleType.Switch, isOn: this.layout.visibleBuiltInIds.includes(id) }).selectedColor(this.themeAccent)
        .width(51).height(31).switchPointColor(Color.White)
        .accessibilityText(this.t('showShortcut').replace('{{label}}', (): string => this.builtIn(id).title))
        .onChange((value: boolean): void => { this.toggleBuiltIn(id, value); })
      this.grip('builtIn', index)
    }.width('100%').height(ROW_HEIGHT).padding({ left: 16, right: 4 }).backgroundColor(this.themeSurface)
      .translate({ y: this.dragSection === 'builtIn' ? this.rowOffset(index, this.dragFrom, this.dragTo, this.dragOffset) : 0 })
      .zIndex(this.dragSection === 'builtIn' && this.dragFrom === index ? 1 : 0)
  }

  @Builder
  private customRow(key: CustomShortcut, index: number) {
    Row({ space: 8 }) {
      this.keycap(key.label)
      Column({ space: 2 }) {
        Text(key.label).fontFamily('Geist').fontSize(15).fontColor(this.themeText)
          .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(key.bytes.replace(/\r/g, ' ↵')).fontFamily('Geist').fontSize(13).fontColor(this.themeSecondary)
          .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
      }.alignItems(HorizontalAlign.Start).layoutWeight(1)
      Toggle({ type: ToggleType.Switch, isOn: key.visible }).selectedColor(this.themeAccent)
        .width(51).height(31).switchPointColor(Color.White)
        .accessibilityText(this.t('showShortcut').replace('{{label}}', (): string => key.label))
        .onChange((value: boolean): void => { this.toggleCustom(key, value); })
      Button({ type: ButtonType.Normal }) {
        Image($r('app.media.lucide_x')).supportSvg2(true).width(16).height(16)
          .colorFilter(lucideColorFilter(this.themeStatusRed))
      }.width(32).height(32).borderRadius(8).backgroundColor(this.themeRaised)
        .accessibilityText(this.t('removeShortcut').replace('{{label}}', (): string => key.label))
        .onClick((): void => { this.saveCustom(this.custom.filter((item: CustomShortcut): boolean => item.id !== key.id)); })
      this.grip('custom', index)
    }.width('100%').height(ROW_HEIGHT).padding({ left: 16, right: 4 }).backgroundColor(this.themeSurface)
      .translate({ y: this.dragSection === 'custom' ? this.rowOffset(index, this.dragFrom, this.dragTo, this.dragOffset) : 0 })
      .zIndex(this.dragSection === 'custom' && this.dragFrom === index ? 1 : 0)
  }

  @Builder
  private rowText(title: string, detail: string) {
    Column({ space: 2 }) {
      Text(title).fontFamily('Geist').fontSize(15).fontWeight(FontWeight.Medium).fontColor(this.themeText)
      Text(detail).fontFamily('Geist').fontSize(13).fontColor(this.themeSecondary)
    }.alignItems(HorizontalAlign.Start).layoutWeight(1)
  }

  @Builder
  private switchRow(title: string, detail: string, directionPad: boolean) {
    Row({ space: 12 }) {
      this.rowText(title, detail)
      Toggle({ type: ToggleType.Switch, isOn: directionPad ? this.layout.directionPadEnabled : this.layout.smartRail })
        .selectedColor(this.themeAccent).width(51).height(31).switchPointColor(Color.White).accessibilityText(title)
        .id(directionPad ? 'terminal-direction-pad-setting' : 'terminal-smart-rail-setting')
        .onChange((value: boolean): void => {
          const next = this.layoutSnapshot();
          if (directionPad) { next.directionPadEnabled = value; } else { next.smartRail = value; }
          this.saveLayout(next);
        })
    }.width('100%').constraintSize({ minHeight: 60 }).padding({ left: 16, right: 16, top: 8, bottom: 8 })
      .borderRadius(16).backgroundColor(this.themeSurface)
  }

  @Builder
  private actionRow(title: string, detail: string, opensSheet: boolean) {
    Button({ type: ButtonType.Normal }) {
      Row({ space: 12 }) {
        this.rowText(title, detail)
        if (opensSheet) {
          Image($r('app.media.lucide_chevron_right')).supportSvg2(true).width(15).height(15)
            .colorFilter(lucideColorFilter(this.themeMuted))
        }
      }.width('100%').padding({ left: 16, right: 16, top: 8, bottom: 8 })
    }.width('100%').constraintSize({ minHeight: 60 }).backgroundColor(Color.Transparent)
      .onClick((): void => {
        if (opensSheet) { this.customOpen = true; } else { this.resetLayout(); }
      })
  }

  @Builder
  private heading(title: string) {
    Text(title).fontFamily('Geist').fontSize(13).fontWeight(FontWeight.Medium).fontColor(this.themeSecondary)
      .width('100%').padding({ left: 16, right: 16, top: 16, bottom: 6 })
  }

  @Builder
  private customSheet() {
    CustomShortcutSheet({ maxFormHeight: Math.max(160, this.viewportBottom - this.viewportTop - 64),
      onSave: (label: string, bytes: string): boolean => this.addCustom(label, bytes) })
  }

  build() {
    Column() {
      this.switchRow(uiText('components.smartRailRow.title', this.uiLocale), uiText('components.smartRailRow.subtitle', this.uiLocale), false)
      if (this.directionPadAvailable) {
        this.heading(this.t('directionPad'))
        this.switchRow(this.t('showDirectionPad'), this.t('showDirectionPadDescription'), true)
      }
      this.heading(this.t('moreKeys'))
      Column() {
        ForEach(this.layout.orderedBuiltInIds, (id: string, index: number) => {
          this.builtInRow(id, index)
          Divider().strokeWidth(0.5).color(this.themeBorder).margin({ left: 16 })
        }, (id: string, index: number): string => index + ':' + id + ':' + this.layout.visibleBuiltInIds.includes(id))
        this.actionRow(this.t('resetDefaults'), this.t('resetDescription'), false)
      }.width('100%').backgroundColor(this.themeSurface).borderRadius(16).clip(true)
      Text(this.t('moreKeysDescription')).fontFamily('Geist').fontSize(13).lineHeight(18).fontColor(this.themeSecondary)
        .width('100%').padding({ left: 16, right: 16, top: 8 })
      this.heading(this.t('customShortcuts'))
      Column() {
        if (this.custom.length === 0) {
          Text(this.t('empty')).fontFamily('Geist').fontSize(13).fontColor(this.themeMuted).width('100%').padding(16)
          Divider().strokeWidth(0.5).color(this.themeBorder).margin({ left: 16 })
        } else {
          ForEach(this.custom, (key: CustomShortcut, index: number) => {
            this.customRow(key, index)
            Divider().strokeWidth(0.5).color(this.themeBorder).margin({ left: 16 })
          }, (key: CustomShortcut, index: number): string => index + ':' + JSON.stringify(key))
        }
        this.actionRow(this.t('addShortcut'), this.t('addDescription'), true)
      }.width('100%').backgroundColor(this.themeSurface).borderRadius(16).clip(true)
      if (this.error) {
        Text(this.error).fontFamily('Geist').fontSize(13).fontColor(this.themeStatusRed)
          .width('100%').padding({ left: 16, right: 16, top: 8 })
      }
    }.width('100%').padding({ top: 16 })
      .bindSheet(this.customOpen, this.customSheet, { height: SheetSize.FIT_CONTENT, backgroundColor: this.themeSheet,
        maskColor: 'rgba(0,0,0,0.55)', showClose: false,
        onDisappear: (): void => { this.customOpen = false; } })
  }
}
