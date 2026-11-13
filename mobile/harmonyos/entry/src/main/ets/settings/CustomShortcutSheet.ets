import { lucideColorFilter } from './LucideColor';
import { uiText } from './NativeUi';
import terminalShortcuts from '../vendor/terminal-shortcuts.js';

type ShortcutStep = 'choose-type' | 'shortcut-combo' | 'special-keys' | 'text-macro';
type ShortcutModifier = 'ctrl' | 'alt' | 'shift';

interface ModifierChoice { id: ShortcutModifier; label: string; }
interface SpecialKeyChoice { id: string; label: string; accessibilityLabel: string; }
interface SpecialKeyGroup { title: string; columns: number; ids: string[]; }
interface ShortcutPreview { label: string; bytes: string; accessibilityLabel: string; }

const MODIFIERS: ModifierChoice[] = [
  { id: 'ctrl', label: 'Ctrl' }, { id: 'alt', label: 'Alt' }, { id: 'shift', label: 'Shift' }
];

const SPECIAL_KEY_GROUPS: SpecialKeyGroup[] = [
  { title: 'editing', columns: 4, ids: ['escape', 'tab', 'enter', 'backspace', 'delete', 'insert', 'space'] },
  { title: 'navigation', columns: 4, ids: ['arrowUp', 'arrowDown', 'arrowLeft', 'arrowRight', 'home', 'end', 'pageUp', 'pageDown'] },
  { title: 'function', columns: 6, ids: ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12'] }
];

@Component
export struct CustomShortcutSheet {
  @StorageProp('uiLocale') locale: string = 'en';
  @StorageProp('themeScheme') scheme: string = 'dark';
  @StorageProp('themeBg') backgroundTint: string = '#0a0a0a';
  @StorageProp('themeRaised') raised: string = '#262626';
  @StorageProp('themeBorder') borderTint: string = 'rgba(255, 255, 255, 0.07)';
  @StorageProp('themeText') text: string = '#fafafa';
  @StorageProp('themeSecondary') secondary: string = '#acacac';
  @StorageProp('themeMuted') muted: string = '#898989';
  @StorageProp('themeAccent') accent: string = '#3276f2';
  @StorageProp('themeWarning') warning: string = '#eab308';
  @StorageProp('themeStatusRed') errorTint: string = '#ff6568';
  @State step: ShortcutStep = 'choose-type';
  @State shortcutKey: string = 'c';
  @State modifiers: ShortcutModifier[] = ['ctrl'];
  @State macroLabel: string = '';
  @State macroText: string = '';
  @State macroEnter: boolean = true;
  @State saveFailed: boolean = false;
  @State accepted: boolean = false;
  @Prop maxFormHeight: number = 440;
  onSave: (label: string, bytes: string) => boolean = (_label: string, _bytes: string): boolean => false;
  private scroller: Scroller = new Scroller();

  private t(key: string): string { return uiText('components.customKeyModal.' + key, this.locale); }

  private title(): string {
    switch (this.step) {
      case 'shortcut-combo': return this.t('shortcutCombo');
      case 'special-keys': return this.t('pickKey');
      case 'text-macro': return this.t('textMacro');
      default: return this.t('addShortcut');
    }
  }

  private show(step: ShortcutStep): void {
    this.saveFailed = false;
    this.step = step;
    this.scroller.scrollEdge(Edge.Top);
  }

  private groupSurface(): string { return this.scheme === 'light' ? this.backgroundTint : this.raised; }

  private specialKey(id: string): SpecialKeyChoice | undefined {
    return terminalShortcuts.TERMINAL_SHORTCUT_SPECIAL_KEYS.find((key: SpecialKeyChoice): boolean => key.id === id);
  }

  private groupKeys(ids: string[]): SpecialKeyChoice[] {
    let keys: SpecialKeyChoice[] = [];
    ids.forEach((id: string): void => {
      let key = this.specialKey(id);
      if (key) { keys.push(key); }
    });
    return keys;
  }

  private combo(): ShortcutPreview | null {
    return terminalShortcuts.buildTerminalShortcutKey({ key: this.shortcutKey, modifiers: this.modifiers });
  }

  private canSave(): boolean {
    return this.step === 'shortcut-combo' ? this.combo() !== null : this.macroText.trim().length > 0;
  }

  private toggleModifier(modifier: ShortcutModifier): void {
    this.modifiers = this.modifiers.includes(modifier)
      ? this.modifiers.filter((value: ShortcutModifier): boolean => value !== modifier)
      : this.modifiers.concat([modifier]);
    this.saveFailed = false;
  }

  private save(label: string, bytes: string): void {
    if (this.accepted) { return; }
    try { this.accepted = this.onSave(label, bytes); }
    catch (e) { this.accepted = false; }
    this.saveFailed = !this.accepted;
  }

  private saveCombo(): void {
    let shortcut = this.combo();
    if (shortcut) { this.save(shortcut.label, shortcut.bytes); }
  }

  private saveMacro(): void {
    let text = this.macroText.trim();
    if (text.length === 0) { return; }
    let label = this.macroLabel.trim() || text.slice(0, 12);
    this.save(label, this.macroEnter ? this.macroText + '\r' : this.macroText);
  }

  @Builder
  private header() {
    Row() {
      if (this.step !== 'choose-type') {
        Button({ type: ButtonType.Normal }) {
          Image($r('app.media.lucide_chevron_left')).supportSvg2(true).width(18).height(18)
            .colorFilter(lucideColorFilter(this.secondary))
        }.width(36).height(40).borderRadius(12).backgroundColor(Color.Transparent)
          .accessibilityText(uiText('返回', this.locale)).onClick((): void => {
            this.show(this.step === 'special-keys' ? 'shortcut-combo' : 'choose-type');
          })
      } else { Blank().width(36) }
      Text(this.title()).fontFamily('Geist').fontSize(15).fontWeight(FontWeight.Medium).fontColor(this.text)
        .layoutWeight(1).textAlign(TextAlign.Center)
      Blank().width(36)
    }.width('100%').constraintSize({ minHeight: 40 }).margin({ bottom: 8 })
  }

  @Builder
  private typeRow(title: string, hint: string, step: ShortcutStep) {
    Button({ type: ButtonType.Normal }) {
      Row({ space: 12 }) {
        Column({ space: 3 }) {
          Text(this.t(title)).fontFamily('Geist').fontSize(16).fontColor(this.text).width('100%')
          Text(this.t(hint)).fontFamily('Geist').fontSize(13).fontColor(this.secondary).width('100%')
        }.layoutWeight(1).alignItems(HorizontalAlign.Start)
        Image($r('app.media.lucide_chevron_right')).supportSvg2(true).width(15).height(15)
          .colorFilter(lucideColorFilter(this.muted))
      }.width('100%').padding({ left: 14, right: 14, top: 10, bottom: 10 })
    }.width('100%').constraintSize({ minHeight: 60 }).backgroundColor(Color.Transparent).borderRadius(0)
      .onClick((): void => this.show(step))
  }

  @Builder
  private chooseType() {
    Column() {
      this.typeRow('shortcutCombo', 'shortcutComboHint', 'shortcut-combo')
      Divider().strokeWidth(0.5).color(this.borderTint).margin({ left: 14 })
      this.typeRow('textMacro', 'textMacroHint', 'text-macro')
    }.width('100%').borderRadius(16).clip(true).backgroundColor(this.groupSurface())
  }

  @Builder
  private keycap(modifier: string = '') {
    Text(modifier || (this.specialKey(this.shortcutKey)?.label ?? this.shortcutKey.toUpperCase()))
      .fontFamily('monospace').fontSize(modifier ? 14 : 17).fontWeight(FontWeight.Medium)
      .fontColor(modifier ? this.secondary : this.combo() ? this.text : this.warning).textAlign(TextAlign.Center)
      .height(48).constraintSize({ minWidth: modifier ? 0 : 48 }).padding({ left: 12, right: 12 })
      .border({ width: 1, radius: 12, color: modifier || this.combo() ? this.borderTint : this.warning })
      .backgroundColor(this.groupSurface())
  }

  @Builder
  private keyPreview() {
    Flex({ wrap: FlexWrap.Wrap, justifyContent: FlexAlign.Center, alignItems: ItemAlign.Center }) {
      ForEach(MODIFIERS.filter((modifier: ModifierChoice): boolean => this.modifiers.includes(modifier.id)),
        (modifier: ModifierChoice, index: number) => {
          Row({ space: 8 }) {
            if (index > 0) { Text('+').fontSize(16).fontColor(this.muted) }
            this.keycap(modifier.label)
          }.margin({ right: 8, bottom: 4 })
        }, (modifier: ModifierChoice, index: number): string => `${modifier.id}:${index === 0}`)
      Row({ space: 8 }) {
        if (this.modifiers.length > 0) { Text('+').fontSize(16).fontColor(this.muted) }
        this.keycap()
      }.margin({ bottom: 4 })
    }.width('100%').padding({ top: 12, bottom: 12 }).accessibilityGroup(true)
      .accessibilityText(this.combo()?.accessibilityLabel ?? this.t('key'))
  }

  @Builder
  private sectionLabel(key: string) {
    Text(this.t(key).toLocaleUpperCase()).fontFamily('Geist').fontSize(11).letterSpacing(0.8)
      .fontColor(this.muted).width('100%').padding({ left: 2 })
  }

  @Builder
  private modifierChip(modifier: ModifierChoice) {
    Button({ type: ButtonType.Normal }) {
      Row({ space: 4 }) {
        Text(modifier.label).fontFamily('Geist').fontSize(14).fontWeight(FontWeight.Medium)
          .fontColor(this.modifiers.includes(modifier.id) ? this.backgroundTint : this.secondary)
        if (modifier.id === 'alt') {
          Text('⌥').fontFamily('monospace').fontSize(13)
            .fontColor(this.modifiers.includes(modifier.id) ? this.backgroundTint : this.muted).opacity(0.65)
        }
      }
    }.layoutWeight(1).height(40).borderRadius(20)
      .backgroundColor(this.modifiers.includes(modifier.id) ? this.text : this.groupSurface())
      .accessibilityText(modifier.label).accessibilitySelected(this.modifiers.includes(modifier.id))
      .onClick((): void => this.toggleModifier(modifier.id))
  }

  @Builder
  private saveButton() {
    if (this.saveFailed) {
      Text(this.t('saveFailed')).fontFamily('Geist').fontSize(13).fontColor(this.errorTint)
        .width('100%').accessibilityText(this.t('saveFailed'))
    }
    Button(this.t(this.step === 'shortcut-combo' ? 'add' : 'addShortcut'), { type: ButtonType.Normal })
      .fontFamily('Geist').fontSize(15).fontWeight(FontWeight.Medium)
      .fontColor(this.canSave() ? this.backgroundTint : this.muted)
      .backgroundColor(this.canSave() ? this.text : this.borderTint).borderRadius(12).width('100%')
      .constraintSize({ minHeight: 44 }).enabled(this.canSave() && !this.accepted)
      .onClick((): void => {
        if (this.step === 'shortcut-combo') { this.saveCombo(); }
        else { this.saveMacro(); }
      })
  }

  @Builder
  private comboForm() {
    Column({ space: 8 }) {
      this.keyPreview()
      this.sectionLabel('modifiers')
      Row({ space: 8 }) {
        ForEach(MODIFIERS, (modifier: ModifierChoice) => { this.modifierChip(modifier) },
          (modifier: ModifierChoice): string => modifier.id)
      }.width('100%').margin({ bottom: 8 })
      this.sectionLabel('key')
      TextInput({ text: this.shortcutKey.length === 1 ? this.shortcutKey.toUpperCase() : '',
        placeholder: this.specialKey(this.shortcutKey)?.label ?? 'C' })
        .width('100%').height(56).borderRadius(12).backgroundColor(this.backgroundTint)
        .border({ width: 1, color: this.borderTint }).fontFamily('monospace').fontSize(22)
        .fontColor(this.text).placeholderColor(this.muted).textAlign(TextAlign.Center)
        .accessibilityText(this.t('key')).enableAutoFill(false).enablePreviewText(false)
        .inputFilter('[ -~]').maxLength(1).enterKeyType(EnterKeyType.Done)
        .onChange((value: string): void => {
          let key = value.length === 0 ? '' : terminalShortcuts.normalizeShortcutKeyInput(value);
          if (key !== null) { this.shortcutKey = key; this.saveFailed = false; }
        })
      Button({ type: ButtonType.Normal }) {
        Text(this.t('moreKeys')).fontFamily('Geist').fontSize(13).fontColor(this.secondary)
          .decoration({ type: TextDecorationType.Underline })
      }.backgroundColor(Color.Transparent).width('100%').constraintSize({ minHeight: 40 })
        .onClick((): void => this.show('special-keys'))
      this.saveButton()
    }.width('100%')
  }

  @Builder
  private specialKeys() {
    Column({ space: 12 }) {
      ForEach(SPECIAL_KEY_GROUPS, (group: SpecialKeyGroup) => {
        Column({ space: 4 }) {
          this.sectionLabel(group.title)
          GridRow({ columns: group.columns, gutter: { x: 4, y: 4 } }) {
            ForEach(this.groupKeys(group.ids), (key: SpecialKeyChoice) => {
              GridCol({ span: 1 }) {
                Button(key.label, { type: ButtonType.Normal }).fontFamily('monospace').fontSize(13)
                  .fontWeight(FontWeight.Medium).padding(0).width('100%').height(40).borderRadius(12)
                  .fontColor(this.shortcutKey === key.id ? this.backgroundTint : this.text)
                  .backgroundColor(this.shortcutKey === key.id ? this.text : this.groupSurface())
                  .accessibilityText(key.accessibilityLabel).accessibilitySelected(this.shortcutKey === key.id)
                  .onClick((): void => { this.shortcutKey = key.id; this.show('shortcut-combo'); })
              }
            }, (key: SpecialKeyChoice): string => key.id)
          }.width('100%')
        }.width('100%')
      }, (group: SpecialKeyGroup): string => group.title)
    }.width('100%')
  }

  @Builder
  private macroField(label: string, placeholder: string, command: boolean) {
    Text(this.t(label)).fontFamily('Geist').fontSize(13).fontWeight(FontWeight.Medium).fontColor(this.secondary)
      .width('100%')
    TextInput({ text: command ? this.macroText : this.macroLabel, placeholder: this.t(placeholder) })
      .width('100%').height(44).borderRadius(12)
      .backgroundColor(this.backgroundTint).border({ width: 1, color: this.borderTint })
      .fontFamily(command ? 'monospace' : 'Geist').fontSize(16).fontColor(this.text).placeholderColor(this.muted)
      .enableAutoFill(false).enterKeyType(EnterKeyType.Done).accessibilityText(this.t(label))
      .onChange((next: string): void => {
        if (command) { this.macroText = next; }
        else { this.macroLabel = next; }
        this.saveFailed = false;
      })
  }

  @Builder
  private macroForm() {
    Column({ space: 8 }) {
      this.macroField('label', 'labelPlaceholder', false)
      this.macroField('command', 'commandPlaceholder', true)
      Row() {
        Text(this.t('pressEnter')).fontFamily('Geist').fontSize(14).fontColor(this.text).layoutWeight(1)
        Toggle({ type: ToggleType.Switch, isOn: this.macroEnter }).selectedColor(this.accent)
          .width(51).height(31).switchPointColor(Color.White).accessibilityText(this.t('pressEnter'))
          .onChange((enabled: boolean): void => { this.macroEnter = enabled; this.saveFailed = false; })
      }.width('100%').constraintSize({ minHeight: 40 })
      this.saveButton()
    }.width('100%').padding(12).borderRadius(16).backgroundColor(this.groupSurface())
  }

  build() {
    Column() {
      this.header()
      Scroll(this.scroller) {
        Column() {
          if (this.step === 'choose-type') { this.chooseType() }
          else if (this.step === 'shortcut-combo') { this.comboForm() }
          else if (this.step === 'special-keys') { this.specialKeys() }
          else { this.macroForm() }
        }.width('100%')
      }.width('100%').height('auto').constraintSize({ maxHeight: this.maxFormHeight }).scrollBar(BarState.Off)
    }.width('100%').constraintSize({ maxWidth: 520 }).padding({ left: 16, right: 16, bottom: 20 })
  }
}
